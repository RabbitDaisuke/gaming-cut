import { rankMasks, nextCorrection, retainTouchedComponents } from './mask-selection.js';
import { createSamCache } from './model-storage.js';
const REVISION = '5850ab45f587c112167512ffef949107115e26a0';
let lib, model, processor, loading;
let currentImage = null, embeddings = null, processed = null;
let source, options, outputWidth, outputHeight;
let runtime = '', threads = 1;
let requestId;
function report(message, progress) { self.postMessage({ type: 'status', requestId, message, progress }); }
async function initialize(mode = 'auto') {
  if (model) return;
  if (loading) return loading;
  loading = (async () => {
    report('切り抜きの準備中');
    lib = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.0');
    const { env } = lib;
    env.allowLocalModels = false;
    env.useBrowserCache = typeof caches !== 'undefined';
    env.useCustomCache = true;
    env.customCache = createSamCache();
    env.useFSCache = false;
    env.remoteHost = 'https://huggingface.co/';
    env.remotePathTemplate = '{model}/resolve/{revision}/';
    // Use the exact ONNX Runtime build bundled with Transformers.js 3.5.0.
    env.backends.onnx.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.0/dist/';
    threads = mode!=='single'&&self.crossOriginIsolated ? Math.max(1, Math.min(8, navigator.hardwareConcurrency || 2)) : 1;
    env.backends.onnx.wasm.numThreads = threads;
    env.backends.onnx.wasm.proxy = false;
    let gpu = false;
    if (mode==='auto' && navigator.gpu) {
      try { gpu = !!(await navigator.gpu.requestAdapter()); } catch {}
    }
    options = { dtype: 'fp32', device: gpu ? 'webgpu' : 'wasm', progress_callback: p => {
      if (p.status === 'progress') report('切り抜きの準備中', p.progress);
    } };
    // A failed ORT initialization can poison its cached initialization promise.
    // The page recreates the entire worker before trying another backend.
    processor=await lib.AutoProcessor.from_pretrained('Xenova/slimsam-77-uniform',{revision:REVISION});
    model=await lib.SamModel.from_pretrained('Xenova/slimsam-77-uniform',{...options,revision:REVISION});
    runtime = 'SlimSAM · 約40 MB · FP32 · '+(gpu ? 'WebGPU' : `CPU · ${threads} threads`);
    self.postMessage({ type: 'runtime', requestId, runtime, isolated: self.crossOriginIsolated, threads });
  })();
  try { await loading; } finally { loading = null; }
}
async function clearEmbedding() {
  if (embeddings) for (const tensor of Object.values(embeddings)) tensor.dispose?.();
  embeddings = null; processed = null; currentImage = null;
}
async function prepareSelection(){
  if(!embeddings){
    let raw=source;
    if(raw.width!==outputWidth||raw.height!==outputHeight)raw=await raw.resize(outputWidth,outputHeight);
    processed=await processor(raw);
    embeddings=await model.get_image_embeddings(processed);
    processed.pixel_values.dispose?.();delete processed.pixel_values;
  }
}
function sendResult(job,masks,scores,width=outputWidth,height=outputHeight){
  self.postMessage({type:'result',requestId:job.requestId,width,height,masks,scores},[masks.buffer]);
}
async function segment(job) {
  requestId=job.requestId;
  await initialize(job.mode);
  const { RawImage, Tensor } = lib;
  if (currentImage !== job.imageId) {
    await clearEmbedding();
    report('写真を切り抜いています');
    source=new RawImage(new Uint8ClampedArray(job.pixels),job.width,job.height,4);source.rgb();
    const scale=Math.min(1,1024/Math.max(source.width,source.height));
    outputWidth=Math.max(1,Math.round(source.width*scale));outputHeight=Math.max(1,Math.round(source.height*scale));
    currentImage = job.imageId;
  }
  await prepareSelection();
  const shape = processed.reshaped_input_sizes[0];
  const pad=processor.image_processor.pad_size;
  const checks=job.points.map(p=>({...p,x:p.x*shape[1]/pad.width,y:p.y*shape[0]/pad.height}));
  const first=job.points.findIndex(p=>p.label===1);
  if(first<0)throw Error('残す場所が選択されていません');
  const used=[first],negative=job.points.findLastIndex(p=>p.label===0);
  if(negative>=0)used.push(negative);
  let best;
  // Dense scribbles are validation samples, not dozens of simultaneous prompts.
  for(let step=0;step<8&&used.length<=8;step++){
    report('選択した範囲を確認しています',step/8*100);
    const prompts=used.map(i=>job.points[i]);
    const input_points=new Tensor('float32',prompts.flatMap(p=>[p.x*shape[1],p.y*shape[0]]),[1,1,prompts.length,2]);
    const input_labels=new Tensor('int64',prompts.map(p=>BigInt(p.label)),[1,1,prompts.length]);
    let outputs;
    try{
      outputs=await model({...embeddings,input_points,input_labels});
      const raw=outputs.pred_masks,width=raw.dims.at(-1),height=raw.dims.at(-2);
      const scores=rankMasks(raw.data,Array.from(outputs.iou_scores.data),width,height,checks);
      const choice=scores.indexOf(Math.max(...scores));
      if(!best||scores[choice]>best.rating)best={rating:scores[choice],scores,data:new Float32Array(raw.data),dims:[...raw.dims]};
      const correction=nextCorrection(raw.data,choice*width*height,width,height,checks,used);
      if(correction<0)break;
      used.push(correction);
    }finally{
      input_points.dispose?.();input_labels.dispose?.();
      outputs?.pred_masks.dispose?.();outputs?.iou_scores.dispose?.();
    }
  }
  report('仕上がりを更新しています');
  const lowWidth=best.dims.at(-1),lowHeight=best.dims.at(-2),n=lowWidth*lowHeight;
  for(let i=0;i<best.scores.length;i++)retainTouchedComponents(best.data.subarray(i*n,(i+1)*n),lowWidth,lowHeight,checks);
  const low=new Tensor('float32',best.data,best.dims);
  let masks;
  try{
    masks=await processor.post_process_masks(low,processed.original_sizes,processed.reshaped_input_sizes,{binarize:false});
    const tensor=masks[0];
    if(tensor.data.length!==outputWidth*outputHeight*best.scores.length)throw Error('選択マスクの大きさが一致しませんでした');
    let result=new Float32Array(tensor.data),resultWidth=outputWidth,resultHeight=outputHeight;
    if(job.targetWidth!==outputWidth||job.targetHeight!==outputHeight){
      const sw=outputWidth,sh=outputHeight,w=job.targetWidth,h=job.targetHeight,scaled=new Float32Array(w*h*best.scores.length);
      for(let c=0;c<best.scores.length;c++)for(let y=0;y<h;y++)for(let x=0;x<w;x++){
        const sx=Math.min(sw-1,x*sw/w),sy=Math.min(sh-1,y*sh/h),x0=Math.floor(sx),y0=Math.floor(sy),x1=Math.min(sw-1,x0+1),y1=Math.min(sh-1,y0+1),fx=sx-x0,fy=sy-y0,offset=c*sw*sh;
        scaled[c*w*h+y*w+x]=(result[offset+y0*sw+x0]*(1-fx)+result[offset+y0*sw+x1]*fx)*(1-fy)+(result[offset+y1*sw+x0]*(1-fx)+result[offset+y1*sw+x1]*fx)*fy;
      }
      result=scaled;resultWidth=w;resultHeight=h;
    }
    const scores=rankMasks(result,best.scores,resultWidth,resultHeight,job.points);
    sendResult(job,result,scores,resultWidth,resultHeight);
  }finally{low.dispose?.();for(const mask of masks||[])mask.dispose?.();}
}
// One queue prevents an encoder session from being overwritten by another image.
let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  if (data.type !== 'segment') return;
  queue = queue.then(() => segment(data)).catch(error => {
    console.error(error);
    self.postMessage({ type: 'error', requestId: data.requestId, message: error.message || String(error) });
  });
};

