// Use the published IMG.LY API, including its quantized model and preprocessing.
import { cacheImglyDownloads } from './model-storage.js';
cacheImglyDownloads();
let requestId;
self.onmessage = async ({data: job}) => {
  if(job.type !== 'segment') return;
  requestId = job.requestId;
  try {
    self.postMessage({type:'status',requestId,message:'背景除去を準備しています'});
    const {removeBackground} = await import('https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm');
    const {width,height,pixels} = job;
    const input = new Blob([pixels],{type:`image/x-rgba8;width=${width};height=${height}`});
    const result = await removeBackground(input,{
      model:'small',device:'cpu',proxyToWorker:false,
      publicPath:'https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/',
      output:{format:'image/x-rgba8'},
      progress:(key,current,total)=>self.postMessage({type:'status',requestId,
        message:key.startsWith('fetch:')?'初回の準備中 · '+(current/1e6).toFixed(1)+' / '+(total/1e6).toFixed(1)+' MB':'被写体を検出しています',
        progress:total?current/total*100:undefined})
    });
    const rgba = new Uint8Array(await result.arrayBuffer());
    if(rgba.length!==width*height*4)throw Error('背景除去の出力サイズが一致しません');
    const alpha = new Float32Array(width*height);
    for(let i=0;i<alpha.length;i++)alpha[i]=rgba[i*4+3]/255;
    self.postMessage({type:'runtime',requestId,runtime:'IMG.LY small · 44.35 MB · WASM · 入力長辺 '+job.inputLimit+' px',isolated:self.crossOriginIsolated});
    self.postMessage({type:'foreground',requestId,width,height,alpha},[alpha.buffer]);
  } catch(error){self.postMessage({type:'error',requestId,message:error.message||String(error)});}
};
