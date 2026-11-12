import { buildOutlineMask } from './outline-mask.js?v=outline-v1';
import { applyErasures } from './erase-paint.js?v=paint-v1';
import { mirrorTile, composeFrame, LOOP_FRAMES, LOOP_FPS, LOOP_MS } from './glitter.js?v=glitter-v6';
import { resizeAlpha, selectForeground, combineForeground, alphaToMask } from './foreground.js';
import { rankMasks } from './mask-selection.js';
import { stillDimensions, imageIsOpaque, canExportJpeg, encodeStill } from './image-output.js';
const $ = id => document.getElementById(id);
const paths = {
  plus:'M12 5v14M5 12h14',close:'m6 6 12 12M18 6 6 18',download:'M12 3v12m-5-5 5 5 5-5M5 15v5h14v-5',
  image:'M4 4h16v16H4zM4 16l5-5 4 4 3-3 4 4M9 8h.01',trash:'M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7',
  undo:'M8 5 3 10l5 5M3 10h11a6 6 0 0 1 0 12','plus-circle':'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M12 7v10M7 12h10',
  lock:'M6 10h12v11H6zM8 10V6a4 4 0 0 1 8 0v4M12 14v3',cutout:'M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5M8 13a4 4 0 1 1 8 0v4H8z'
};
function icon(name) { return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+(paths[name] || paths.image)+'"/></svg>'; }
document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });
const images = [];
let localId = 0;
const nextId = () => 'local-'+(++localId);
let activeId = null, tool = 'add', background = 'transparent', showOriginal = false;
let worker, busy = false, requestCounter = 0, activeRequest = null, bootReady = false, engineError = '';
let workerMode = 'auto', watchdog = 0, attemptDeadline = 0;
let workerKind = '', idleWorkerTimer = 0;
let saving = false, toastTimer, keyboardVisible = false;
let outputFormat = 'mp4', previewPlaying = !matchMedia('(prefers-reduced-motion: reduce)').matches;
let texture = null, tile = null, cancelExport = null, animationTime = 0, animationTick = 0;
const previewLayers = {base: document.createElement('canvas'), mask: document.createElement('canvas')};
const previewEffect = document.createElement('canvas');
const textureReady = (async () => {
  const image = new Image(); image.src = new URL('./assets/rainbow-glitter.png', import.meta.url).href;
  await image.decode(); texture = image; tile = mirrorTile(image); drawResult();
})();
textureReady.catch(() => toast('ラメ画像を読み込めません。再読み込みしてください。'));
let stroke = null, strokeFrame = 0;
let eraseStroke = null, eraseFrame = 0, eraseSize = 2;
const eraseSizes = [8,16,32,64,96];
const pending = new Map();
const keyboardPoint = { x:.5, y:.5 };
function active() { return images.find(im => im.id === activeId); }
function object(im = active()) { return im?.objects.find(o => o.id === im.objectId); }
function element(tag, className, text) { const el = document.createElement(tag); if(className)el.className=className;if(text!=null)el.textContent=text;return el; }
function toast(message) { $('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,4500); }
function status(message) { $('status').textContent=message; }
function selectedObjects(im) { return im?.objects.filter(o => o.enabled && o.points.length) || []; }
function waiting(im) { return selectedObjects(im).some(o => !o.masks); }
function ready(im) { return !!im?.mask && !waiting(im) && stroke?.imageId!==im.id; }
function randomPngFrame(previous = -1) {
  return previous < 0 ? Math.floor(Math.random() * LOOP_FRAMES)
    : (previous + 1 + Math.floor(Math.random() * (LOOP_FRAMES - 1))) % LOOP_FRAMES;
}
function createObject(im) { const o={id:nextId(),number:im.nextObject++,enabled:true,points:[],strokes:[],masks:null,scores:[],choice:0,version:0,error:''};im.objects.push(o);im.objectId=o.id;return o; }
function saveHistory(im) { im.history.push({objects:im.objects.map(o=>({...o,points:o.points.map(p=>({...p})),strokes:[...o.strokes]})),objectId:im.objectId,erasures:[...(im.erasures||[])]});if(im.history.length>20)im.history.shift(); }

async function addFiles(files) {
  let firstAdded;
  for(const file of files) {
    if(!file.type.startsWith('image/')) {toast(file.name+': 画像ファイルを選択してください');continue;}
    if(file.size>80_000_000){toast(file.name+': 80 MB以下の画像を選択してください');continue;}
    const url=URL.createObjectURL(file);
    try {
      const img=new Image();img.src=url;await img.decode();
      if(img.naturalWidth*img.naturalHeight>50_000_000)throw Error('5,000万画素以下の画像を選択してください');
      const im={id:nextId(),name:file.name,url,img,width:img.naturalWidth,height:img.naturalHeight,selected:true,objects:[],objectId:null,nextObject:1,history:[],feather:1,threshold:0,crop:false,mask:null,bounds:null,version:0,message:'',progress:null};
      im.opaqueSource=imageIsOpaque(img,im.width,im.height);
      im.erasures=[];im.glitter=.30;im.inputLimit=1024;im.foreground=null;im.keepBackground=true;im.mp4Fill='#ffffff';im.pngFrame=randomPngFrame();images.push(im);firstAdded ||= im.id;
    } catch(error) {URL.revokeObjectURL(url);toast(file.name+': '+(error.message.includes('画素')?error.message:'画像を読み込めません'));}
  }
  selectImage(firstAdded || activeId);
}
function renderLibrary() {
  const list=$('image-list');list.replaceChildren();
  for(const im of images) {
    const item=element('div','image-item'+(im.id===activeId?' active':''));
    const open=element('button','image-open');open.setAttribute('aria-label',im.name+'を編集');open.setAttribute('aria-current',String(im.id===activeId));
    const img=new Image();img.src=im.url;img.alt='';
    const caption=element('div','image-caption');caption.append(element('strong','',im.name),element('span','',ready(im)?'完成':''));
    open.append(img,caption);open.onclick=()=>selectImage(im.id);item.append(open);
    if(ready(im)) {
      const label=element('label','image-check'), check=element('input');check.type='checkbox';check.checked=im.selected;
      check.setAttribute('aria-label',im.name+'をまとめて保存に含める');check.onchange=()=>{im.selected=check.checked;updateButtons();};label.append(check);item.append(label);
    }
    list.append(item);
  }
  $('image-count').textContent=images.length;updateButtons();
}
function selectImage(id) {
  cancelStroke();cancelErase();$('erase-cursor').hidden=true;
  activeId=images.find(i=>i.id===id)?.id||null;const im=active();
  $('empty').hidden=!!im;$('editing').hidden=!im;showOriginal=false;tool='add';keyboardVisible=false;
  $('finishing').open=false;
  if(im){$('filename').textContent=im.name;$('dimensions').textContent=im.width.toLocaleString()+' × '+im.height.toLocaleString();$('feather').value=im.feather;$('threshold').value=im.threshold;$('crop').checked=im.crop;$('glitter-opacity').value=Math.round(im.glitter*100);$('glitter-value').textContent=Math.round(im.glitter*100)+'%';}
  if(im){$('keep-background').checked=im.keepBackground;$('mp4-fill').value=im.mp4Fill;}
  updateAdjustmentLabels();renderLibrary();renderObjects();draw();status(im?'':'');
}
// A visual thumbnail of each chosen item; before inference, show its clicked area.
function thumbnail(im,o,choice=o.choice) {
  const out=element('canvas');out.width=160;out.height=112;const ctx=out.getContext('2d');
  if(!o.masks) {
    const p=o.points.find(p=>p.label===1);
    if(p){const side=Math.min(im.width,im.height)*.36;const x=Math.max(0,Math.min(im.width-side,p.x*im.width-side/2)), y=Math.max(0,Math.min(im.height-side,p.y*im.height-side/2));ctx.drawImage(im.img,x,y,side,side,24,0,112,112);}
    return out;
  }
  const key=choice+':'+im.threshold;
  o.thumbnails ||= {};
  if(o.thumbnails[key]){ctx.drawImage(o.thumbnails[key],0,0);return out;}
  const {width,height}=o,n=width*height,mask=element('canvas');mask.width=width;mask.height=height;
  const mx=mask.getContext('2d'), px=mx.createImageData(width,height);let l=width,t=height,r=-1,b=-1;
  const alpha=buildOutlineMask([{...o,choice}],width,height,im.threshold);
  for(let i=0;i<n;i++){const a=alpha[i];px.data[i*4+3]=a;if(a){const x=i%width,y=Math.floor(i/width);l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);}}
  mx.putImageData(px,0,0);mx.globalCompositeOperation='source-in';mx.drawImage(im.img,0,0,width,height);
  if(r>=l){const w=r-l+1,h=b-t+1,s=Math.min(144/w,96/h);ctx.drawImage(mask,l,t,w,h,(160-w*s)/2,(112-h*s)/2,w*s,h*s);}
  o.thumbnails[key]=out;return out;
}
function renderObjects() {
  const im=active(), list=$('object-list');list.replaceChildren();
  $('object-count').textContent=selectedObjects(im).length;
  if(!im?.objects.length)list.append(element('span','selection-empty','未選択'));
  for(const o of im?.objects||[]) {
    const row=element('div','object-item'+(im.objectId===o.id?' active':'')+(!o.enabled?' excluded':''));
    const open=element('button','object-open checker');open.append(thumbnail(im,o));open.setAttribute('aria-label','選択 '+o.number+' を調整');
    open.onclick=()=>{im.objectId=o.id;setTool('keep');renderObjects();draw();};
    const bottom=element('div','object-bottom'),label=element('label'),check=element('input');
    check.type='checkbox';check.checked=o.enabled;check.setAttribute('aria-label','選択 '+o.number+' を残す');
    check.onchange=()=>{saveHistory(im);o.enabled=check.checked;recompute(im);renderObjects();renderLibrary();draw();};
    label.append(check,element('span','',String(o.number)));
    const del=element('button','icon-button object-delete');del.innerHTML=icon('close');del.setAttribute('aria-label','選択 '+o.number+' を取り消す');
    del.onclick=()=>{saveHistory(im);im.objects=im.objects.filter(x=>x!==o);pending.delete(im.id+':'+o.id);if(im.objectId===o.id)im.objectId=im.objects.at(-1)?.id||null;if(!im.objects.length)tool='add';recompute(im);renderObjects();renderLibrary();draw();};
    bottom.append(label,del);row.append(open,bottom);list.append(row);
  }
  renderCandidates();updateButtons();
}
function renderCandidates() {
  const im=active(), o=object(im), list=$('mask-choices');list.replaceChildren();
  $('candidate-label').textContent=o?'選択 '+o.number+' のラメを重ねる範囲':'ラメを重ねる範囲';
  if(!o?.masks){list.append(element('span','','対象の選択後に表示'));return;}
  if(!$('finishing').open)return;
  o.scores.forEach((_,i)=>{const b=element('button','checker');b.append(thumbnail(im,o,i),element('span','','範囲 '+(i+1)));b.setAttribute('aria-pressed',String(o.choice===i));b.onclick=()=>{saveHistory(im);o.choice=i;recompute(im);renderObjects();draw();};list.append(b);});
}
function updateButtons() {
  const im=active(),o=object(im);
  if(outputFormat==='jpeg'&&!canExportJpeg(im))outputFormat='webp';
  const painting=!!eraseStroke;
  $('export').disabled=!ready(im)||saving||painting||busy;$('show-original').disabled=!im?.mask||painting;
  $('cancel-save').hidden=!saving||outputFormat!=='mp4';
  $('export-label').textContent=saving?'保存用データを作成中…':(outputFormat!=='mp4'&&!im?.keepBackground?'透過':'')+outputFormat.toUpperCase()+'を保存';
  for(const format of ['mp4','webp','png','jpeg']){$('format-'+format).disabled=saving||(format==='jpeg'&&!canExportJpeg(im));$('format-'+format).setAttribute('aria-pressed',String(outputFormat===format));}
  $('format-jpeg').title=canExportJpeg(im)?'JPEG品質95で保存':'透過なし（背景ON・元画像も不透明）の場合に利用できます';
  $('still-size').disabled=saving||outputFormat==='mp4';
  $('preview-play').disabled=!im||saving;
  $('preview-play').textContent=outputFormat!=='mp4'?'別のフレーム':previewPlaying?'一時停止':'再生';
  if(outputFormat!=='mp4')$('preview-play').removeAttribute('aria-pressed');
  else $('preview-play').setAttribute('aria-pressed',String(previewPlaying));
  $('glitter-opacity').disabled=!im||saving;$('mp4-size').disabled=saving||outputFormat!=='mp4';
  $('keep-background').disabled=!im||saving||painting;
  $('mp4-fill-row').hidden=outputFormat!=='mp4'||!im||im.keepBackground;
  $('mp4-fill').disabled=saving;
  $('erase-undo').disabled=!im?.history.length&&!painting;
  for(let i=0;i<eraseSizes.length;i++){$('erase-size-'+i).disabled=!ready(im)||showOriginal||painting;$('erase-size-'+i).setAttribute('aria-pressed',String(i===eraseSize));}
  $('result').classList.toggle('erasable',ready(im)&&!showOriginal);
  if(!ready(im)||showOriginal)$('erase-cursor').hidden=true;
  $('show-original').setAttribute('aria-pressed',String(showOriginal));$('show-original').textContent=showOriginal?'仕上がりに戻る':'元の写真と見比べる';
  $('undo').disabled=!im?.history.length;$('reset').disabled=!im?.objects.length;$('refine').disabled=!o;
  $('refine').setAttribute('aria-expanded',String(tool!=='add'&&!!o));$('refine-tools').hidden=tool==='add'||!o;
  $('refine-label').textContent=o?'選択 '+o.number+' を調整':'';
  for(const name of ['add','keep','remove'])$('tool-'+name).setAttribute('aria-pressed',String(tool===name));
  $('action-label').textContent={add:'なぞって選ぶ',keep:'なぞって広げる',remove:'なぞって除く'}[tool];
  for(const id of ['feather','threshold'])$(id).disabled=!im?.mask||saving;
  $('crop').disabled=!im?.mask||im.keepBackground||saving;
  const count=images.filter(im=>im.selected&&ready(im)).length;
  $('export-batch').disabled=!count||saving||painting||busy;$('batch-label').textContent=count?count+'枚をまとめて保存':'まとめて保存';
  $('batch-count').textContent=count?'選択した完成画像をZIPで保存':'完成した画像をZIPで保存';
}
function updateAdjustmentLabels() { $('feather-value').textContent=$('feather').value;const t=Number($('threshold').value);$('threshold-value').textContent=t===0?'標準':t>0?'広め':'狭め'; }
function setTool(value) {cancelStroke();tool=value;updateButtons();draw();}
function recompute(im) {
  const objects = im.objects.filter(o => o.enabled && o.masks);
  if (!objects.length) { im.mask = null; im.bounds = null; updateButtons(); return; }
  const { width, height } = objects[0];
  const c = document.createElement('canvas'); c.width = width; c.height = height; const ctx = c.getContext('2d'); const pixels = ctx.createImageData(width, height); const n = width * height;
  const outline = buildOutlineMask(objects,width,height,im.threshold);
  let left = width, top = height, right = -1, bottom = -1;
  for (let i = 0; i < n; i++) {
    const alpha = outline[i];
    const k = i * 4; pixels.data[k] = 255; pixels.data[k+1] = 255; pixels.data[k+2] = 255; pixels.data[k+3] = alpha;
    if (alpha > 0) { const x = i % width, y = Math.floor(i / width); left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
  }
  ctx.putImageData(pixels, 0, 0);
  if (im.feather > 0) { const smooth = document.createElement('canvas'); smooth.width = width; smooth.height = height; const sx = smooth.getContext('2d'); sx.filter = `blur(${im.feather * width / im.width}px)`; sx.drawImage(c, 0, 0); im.mask = smooth; } else im.mask = c;
  const pad = Math.ceil(im.feather * 3 + 2);
  im.bounds = right < left ? null : { x: Math.max(0, Math.floor(left / width * im.width) - pad), y: Math.max(0, Math.floor(top / height * im.height) - pad), right: Math.min(im.width, Math.ceil((right+1) / width * im.width) + pad), bottom: Math.min(im.height, Math.ceil((bottom+1) / height * im.height) + pad) };
  if (!im.bounds) im.mask = null; updateErasedBounds(im);updateButtons();
}
function imageBounds(im){return {x:0,y:0,width:im.width,height:im.height};}
function updateErasedBounds(im){
  im.erasedBounds=im.bounds;
  if(!im.mask||!im.erasures?.length)return;
  const c=element('canvas');c.width=im.mask.width;c.height=im.mask.height;const ctx=c.getContext('2d');
  ctx.drawImage(im.mask,0,0);applyErasures(ctx,im.erasures,imageBounds(im),c.width,c.height);
  const px=ctx.getImageData(0,0,c.width,c.height).data;let l=c.width,t=c.height,r=-1,b=-1;
  for(let i=0;i<c.width*c.height;i++)if(px[i*4+3]){const x=i%c.width,y=Math.floor(i/c.width);l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);}
  im.erasedBounds=r<l?null:{x:Math.floor(l/c.width*im.width),y:Math.floor(t/c.height*im.height),right:Math.ceil((r+1)/c.width*im.width),bottom:Math.ceil((b+1)/c.height*im.height)};
}
function renderCut(im, width, height) { const c = document.createElement('canvas'); c.width = width; c.height = height; const ctx = c.getContext('2d'); if (!im.mask) return c; ctx.drawImage(im.img, 0, 0, width, height); ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(im.mask, 0, 0, width, height);ctx.globalCompositeOperation='source-over';applyErasures(ctx,im.erasures,imageBounds(im),width,height); return c; }
function outputBounds(im) { const b=im.erasures?.length?im.erasedBounds:im.bounds;return !im.keepBackground && im.crop && b ? { x:b.x,y:b.y,width:b.right-b.x,height:b.bottom-b.y } : imageBounds(im); }

function draw() {
  const im=active();$('pins').replaceChildren();if(!im)return;
  const area=$('canvas-area'),ratio=Math.max(.01,Math.min((area.clientWidth-40)/im.width,(area.clientHeight-40)/im.height));
  const w=Math.max(1,Math.round(im.width*ratio)),h=Math.max(1,Math.round(im.height*ratio)),dpr=Math.min(2,devicePixelRatio||1);
  $('frame').style.width=w+'px';$('frame').style.height=h+'px';
  const canvas=$('canvas');canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);
  const ctx=canvas.getContext('2d'),cw=canvas.width,ch=canvas.height;ctx.drawImage(im.img,0,0,cw,ch);
  if(im.mask){
    // Leave selected food in full color and dim the surrounding photo.
    ctx.fillStyle='rgba(22,36,27,.36)';ctx.fillRect(0,0,cw,ch);ctx.drawImage(renderCut(im,cw,ch),0,0);
  }
  for(const o of im.objects)if(o.enabled)for(const s of o.strokes){
    const p={...s.path[0],label:s.label};
    const pin=element('span','pin'+(p.label===0?' negative':'')+(o.id===im.objectId?'':' inactive'),p.label===0?'−':String(o.number));
    pin.style.left=(p.x*100)+'%';pin.style.top=(p.y*100)+'%';$('pins').append(pin);
  }
  drawStrokes();
  if(keyboardVisible){const p=element('span','pin','+');p.style.left=(keyboardPoint.x*100)+'%';p.style.top=(keyboardPoint.y*100)+'%';$('pins').append(p);}
  drawResult();
}
function drawResult(){
  const im=active();if(!im)return;
  const dpr=Math.min(2,devicePixelRatio||1),live=eraseStroke?.imageId===im.id?eraseStroke:null;
  const rc=$('result'),ra=$('result-area'),bounds=showOriginal?imageBounds(im):live?.bounds||outputBounds(im);
  const rs=Math.max(.01,Math.min((ra.clientWidth-40)/bounds.width,(ra.clientHeight-40)/bounds.height));
  rc.width=Math.max(1,Math.round(bounds.width*rs*dpr));rc.height=Math.max(1,Math.round(bounds.height*rs*dpr));
  rc.style.width=Math.round(bounds.width*rs)+'px';rc.style.height=Math.round(bounds.height*rs)+'px';
  const rx=rc.getContext('2d');
  if(showOriginal)rx.drawImage(im.img,0,0,rc.width,rc.height);
  else {
    const layers=outputLayers(im,rc.width,rc.height,bounds,live,previewLayers);
    composeFrame(rx,{...layers,texture,tile,bounds,imageWidth:im.width,imageHeight:im.height,
      amount:im.glitter,keepBackground:im.keepBackground,
      phase:outputFormat!=='mp4'?im.pngFrame/LOOP_FRAMES:Math.floor(animationTime/(1000/LOOP_FPS))%LOOP_FRAMES/LOOP_FRAMES,
      matte:outputFormat==='mp4'?im.mp4Fill:null},previewEffect);
  }
  ra.style.backgroundColor=background==='transparent'?'':background;ra.style.backgroundImage=background==='transparent'?'':'none';
  const dimensions=outputFormat==='mp4'?mp4Dimensions(outputBounds(im)):stillDimensions(outputBounds(im),Number($('still-size').value));
  const bg=im.keepBackground?'元の背景':outputFormat==='mp4'?'背景 '+im.mp4Fill:'背景は透明';
  $('output-size').textContent=im.mask?dimensions.width.toLocaleString()+' × '+dimensions.height.toLocaleString()+' px · '+(outputFormat==='mp4'?'MP4 / 25fps / 3.2秒':outputFormat==='webp'?'WebP / 品質85':outputFormat==='jpeg'?'JPEG / 品質95':'PNG')+' · '+bg:'';
  $('result-count').textContent=showOriginal?'元の写真':(ready(im)?selectedObjects(im).length+'個にラメ · ':'')+bg;
  renderResultState();
}
function renderResultState(){
  const im=active();if(!im)return;const selected=selectedObjects(im);
  const error=selected.find(o=>o.error)?.error||(selected.length?engineError:'');
  const drawing=stroke?.imageId===im.id,processing=waiting(im)&&!error;
  const placeholder=$('result-placeholder');placeholder.hidden=ready(im)&&!error||showOriginal||im.keepBackground&&!selected.length&&!drawing;
  placeholder.className='result-placeholder'+(error?' error':processing?' working':'');
  $('result').hidden=!im.mask&&!showOriginal&&!im.keepBackground;
  $('result-message').textContent=error?'対象を選択できませんでした':drawing?'選択中':processing?(im.message||'対象を選択しています'):selected.length?'対象の範囲が見つかりませんでした':'まだ選ばれていません';
  $('retry').hidden=!error;$('error-details').hidden=!error;$('error-detail').textContent=error;
  $('progress').hidden=!processing;
  if(Number.isFinite(im.progress))$('progress').value=im.progress;else $('progress').removeAttribute('value');
  $('result-area').setAttribute('aria-busy',String(processing));
}
function reportProgress(message,progress){
  const im=images.find(i=>i.id===activeRequest?.imageId);
  if(im){im.message=message;im.progress=progress;if(im.id===activeId)renderResultState();}
}
function watchWorker(){
  clearTimeout(watchdog);
  if(!activeRequest)return;
  watchdog=setTimeout(()=>failWorker('処理から応答がありませんでした。もう一度試してください。'),Math.max(0,Math.min(60000,attemptDeadline-Date.now())));
}
function failWorker(message){
  const job=activeRequest,im=images.find(i=>i.id===job?.imageId),o=im?.objects.find(o=>o.id===job.objectId);
  clearTimeout(watchdog);worker?.terminate();worker=null;busy=false;activeRequest=null;
  if(o&&o.version===job.version&&im.version===job.imageVersion){
    if(im.inputLimit>512){
      im.inputLimit=im.inputLimit===1024?768:512;
      im.message='入力を長辺 '+im.inputLimit+' pxに縮小して再試行しています';im.progress=null;
      pending.set(im.id+':'+o.id,{im,o});
    }else if(job.engine==='sam'&&workerMode!=='single'){
      workerMode=workerMode==='auto'?'wasm':'single';
      im.message='別の実行方式で再試行しています';im.progress=null;
      pending.set(im.id+':'+o.id,{im,o});
    }else{o.error=message;im.progress=null;}
  }
  updateButtons();draw();processQueue();
}
function ensureWorker(kind){
  clearTimeout(idleWorkerTimer);
  if(worker&&workerKind===kind)return;
  worker?.terminate();workerKind=kind;
  worker=new Worker(kind==='imgly'?'./inference-worker.js?v=glitter-v4':'./sam-worker.js?v=glitter-v4',{type:'module'});
  const instance=worker;
  worker.onmessage=({data})=>{
    if(worker!==instance||!activeRequest||data.requestId!==activeRequest.requestId)return;
    if(data.type==='status'){watchWorker();reportProgress(data.message,data.progress);return;}
    if(data.type==='runtime'){$('runtime').textContent=data.runtime+' / クロスオリジン分離: '+(data.isolated?'有効':'無効');return;}
    if(data.type==='error'){failWorker(data.message||'処理に失敗しました');return;}
    if(data.type==='foreground'){
      const job=activeRequest,im=images.find(i=>i.id===job.imageId),o=im?.objects.find(o=>o.id===job.objectId);
      if(im&&data.alpha?.length===data.width*data.height){
        const s=Math.min(1,1024/Math.max(im.width,im.height));
        im.analysisWidth=Math.max(1,Math.round(im.width*s));im.analysisHeight=Math.max(1,Math.round(im.height*s));
        im.foreground=resizeAlpha(data.alpha,data.width,data.height,im.analysisWidth,im.analysisHeight);
        if(o&&o.version===job.version&&im.version===job.imageVersion)pending.set(im.id+':'+o.id,{im,o});
      }else{failWorker('背景除去のマスクを受信できませんでした');return;}
      // Termination releases the library's memoized ORT session before SAM or MP4.
      clearTimeout(watchdog);worker.terminate();worker=null;busy=false;activeRequest=null;processQueue();return;
    }
    if(data.type!=='result')return;
    if(!Number.isInteger(data.width)||!Number.isInteger(data.height)||data.width<1||data.height<1||!data.scores?.length||data.masks?.length!==data.width*data.height*data.scores.length){failWorker('切り抜き結果を読み込めませんでした');return;}
    const job=activeRequest,im=images.find(i=>i.id===job.imageId),o=im?.objects.find(o=>o.id===job.objectId);
    if(o&&o.version===job.version&&im.version===job.imageVersion){
      if(data.type==='result'){
        if(job.engine==='sam'&&im.foreground){
          const selection=selectForeground(im.foreground,im.analysisWidth,im.analysisHeight,o.points);
          Object.assign(data,combineForeground(selection,data.masks,data.scores,data.width,data.height,o.points,rankMasks));
        }
        Object.assign(o,{masks:data.masks,scores:data.scores,width:data.width,height:data.height,thumbnails:{},error:''});
        o.choice=data.scores.indexOf(Math.max(...data.scores));im.message='';im.progress=null;
        recompute(im);if(im.id===activeId)status(im.mask?'対象にラメを重ねました':'別の場所を選び直してください');
      }else if(data.type==='error'){o.error=data.message||'処理に失敗しました';}
    }
    clearTimeout(watchdog);busy=false;activeRequest=null;renderLibrary();if(im?.id===activeId){renderObjects();draw();}updateButtons();processQueue();
    if(!busy)idleWorkerTimer=setTimeout(()=>{if(!busy){worker?.terminate();worker=null;}},15000);
  };
  worker.onerror=event=>{
    if(worker===instance)failWorker(event.message||'処理を開始できませんでした');
  };
  worker.onmessageerror=()=>{if(worker===instance)failWorker('切り抜き結果を受信できませんでした');};
}
function queueObject(im,o){
  o.version++;o.masks=null;o.scores=[];o.thumbnails={};o.error='';
  im.message='対象を選択しています';im.progress=null;
  recompute(im);pending.set(im.id+':'+o.id,{im,o});processQueue();if(im.id===activeId){renderObjects();draw();}
}
function processQueue(){
  if(busy||saving||!bootReady||!pending.size)return;
  const [key,{im,o}]=pending.entries().next().value;pending.delete(key);
  if(!images.includes(im)||!im.objects.includes(o)||!o.points.some(p=>p.label===1)){processQueue();return;}
  const selection=im.foreground?selectForeground(im.foreground,im.analysisWidth,im.analysisHeight,o.points):null;
  if(selection&&!selection.needsRefinement){
    Object.assign(o,{masks:Float32Array.from(selection.alpha,alphaToMask),scores:[1],choice:0,width:im.analysisWidth,height:im.analysisHeight,thumbnails:{},error:''});
    im.message='';im.progress=null;recompute(im);renderLibrary();if(im.id===activeId){renderObjects();draw();status('被写体にラメを重ねました');}queueMicrotask(processQueue);return;
  }
  const engine=im.foreground?'sam':'imgly';
  try{ensureWorker(engine);}catch(error){o.error=error.message;draw();return;}
  busy=true;activeRequest={requestId:++requestCounter,imageId:im.id,objectId:o.id,version:o.version,imageVersion:im.version,engine};
  attemptDeadline=Date.now()+180000;watchWorker();
  try{
    const scale=Math.min(1,im.inputLimit/Math.max(im.width,im.height));
    const c=document.createElement('canvas');c.width=Math.max(1,Math.round(im.width*scale));c.height=Math.max(1,Math.round(im.height*scale));
    const ctx=c.getContext('2d');ctx.drawImage(im.img,0,0,c.width,c.height);const pixels=ctx.getImageData(0,0,c.width,c.height).data;
    worker.postMessage({type:'segment',...activeRequest,pixels,width:c.width,height:c.height,inputLimit:im.inputLimit,targetWidth:im.analysisWidth,targetHeight:im.analysisHeight,points:o.points,mode:workerMode},[pixels.buffer]);
    c.width=c.height=1;
  }catch(error){failWorker(error.message);}
  updateButtons();
}
const clamp = value => Math.max(0,Math.min(1,value));
// Arc-length sampling makes slow, fast and coalesced pointer events equivalent.
// Keep each gesture as one group, with at most 64 coverage samples.
function sampleStroke(path,im,label){
  const scale=Math.max(im.width,im.height);
  const distance=(a,b)=>Math.hypot((a.x-b.x)*im.width/scale,(a.y-b.y)*im.height/scale);
  const lengths=[0];
  for(let i=1;i<path.length;i++)lengths.push(lengths[i-1]+distance(path[i-1],path[i]));
  const length=lengths.at(-1);
  if(!length)return [{...path[0],label}];
  const count=Math.min(64,Math.max(2,Math.ceil(length/.025)+1)),points=[];
  let j=1;
  for(let i=0;i<count;i++){
    const target=length*i/(count-1);
    while(j<path.length-1&&lengths[j]<target)j++;
    const t=(target-lengths[j-1])/(lengths[j]-lengths[j-1]||1),a=path[j-1],b=path[j];
    points.push({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,label});
  }
  return points;
}
function commitStroke(path,label,mode=tool){
  const im=active();if(!im)return;
  let o=object(im);
  if(!label&&!o){toast('先に残すものを選んでください');return;}
  if(mode!=='add'&&!o)return;
  saveHistory(im);
  if(label&&mode==='add')o=createObject(im);
  if(!o)return;
  o.enabled=true;o.strokes.push({path,label});o.points.push(...sampleStroke(path,im,label));
  queueObject(im,o);status(selectedObjects(im).length+'個を選択');
}
function addPoint(x,y,negative=false){commitStroke([{x:clamp(x),y:clamp(y)}],negative||tool==='remove'?0:1);}
function drawStrokes(){
  const im=active(),overlay=$('stroke-overlay'),canvas=$('canvas');
  overlay.width=canvas.width;overlay.height=canvas.height;
  if(!im)return;
  const ctx=overlay.getContext('2d'),w=overlay.width,h=overlay.height,dpr=Math.min(2,devicePixelRatio||1);
  function line(s,selected=true){
    ctx.globalAlpha=selected ? .9 : .45;ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();
    s.path.forEach((p,i)=>i?ctx.lineTo(p.x*w,p.y*h):ctx.moveTo(p.x*w,p.y*h));
    if(s.path.length===1)ctx.lineTo(s.path[0].x*w+.1,s.path[0].y*h);
    ctx.strokeStyle='#fff';ctx.lineWidth=7*dpr;ctx.stroke();
    ctx.strokeStyle=s.label?'#326343':'#ad3f37';ctx.lineWidth=4*dpr;ctx.stroke();
  }
  for(const o of im.objects)if(o.enabled)for(const s of o.strokes)line(s,o.id===im.objectId);
  if(stroke?.imageId===im.id)line(stroke);
}
function scheduleStrokeDraw(){if(!strokeFrame)strokeFrame=requestAnimationFrame(()=>{strokeFrame=0;drawStrokes();});}
function capturePoint(e){
  const r=stroke.rect,p={x:clamp((e.clientX-r.left)/r.width),y:clamp((e.clientY-r.top)/r.height)},last=stroke.path.at(-1);
  if(p.x!==last?.x||p.y!==last?.y)stroke.path.push(p);
  // Bound raw input storage during very long gestures without truncating the end.
  if(stroke.path.length>1024)stroke.path=stroke.path.filter((_,i)=>i%2===0||i===stroke.path.length-1);
}
function cancelStroke(){
  if(!stroke)return false;
  const id=stroke.pointerId;stroke=null;
  if($('canvas').hasPointerCapture(id))$('canvas').releasePointerCapture(id);
  drawStrokes();updateButtons();renderResultState();return true;
}
function moveEraseCursor(e){
  const cursor=$('erase-cursor');
  if(!ready(active())||showOriginal){cursor.hidden=true;return;}
  const area=$('result-area').getBoundingClientRect(),size=eraseSizes[eraseSize];
  cursor.style.width=size+'px';cursor.style.height=size+'px';
  cursor.style.left=(e.clientX-area.left+$('result-area').scrollLeft)+'px';
  cursor.style.top=(e.clientY-area.top+$('result-area').scrollTop)+'px';cursor.hidden=false;
}
function captureErasePoint(e){
  const s=eraseStroke,r=$('result').getBoundingClientRect(),b=s.bounds;
  if(!r.width||!r.height)return;
  // Keep outside coordinates: the canvas clips the brush without moving it to an edge.
  const p={x:b.x+(e.clientX-r.left)/r.width*b.width,y:b.y+(e.clientY-r.top)/r.height*b.height};
  const last=s.path.at(-1);
  if(!last||p.x!==last.x||p.y!==last.y)s.path.push(p);
}
function cancelErase(){
  if(!eraseStroke)return false;
  const id=eraseStroke.pointerId;eraseStroke=null;
  if($('result').hasPointerCapture(id))$('result').releasePointerCapture(id);
  $('erase-cursor').hidden=true;drawResult();updateButtons();return true;
}
function finishErase(){
  if(!eraseStroke)return false;
  const finished=eraseStroke;eraseStroke=null;
  if($('result').hasPointerCapture(finished.pointerId))$('result').releasePointerCapture(finished.pointerId);
  const im=active();if(im?.id===finished.imageId){saveHistory(im);(im.erasures||=[]).push({path:finished.path,radius:finished.radius});updateErasedBounds(im);}
  $('erase-cursor').hidden=true;updateButtons();draw();return true;
}
for(let i=0;i<eraseSizes.length;i++)$('erase-size-'+i).onclick=()=>{eraseSize=i;$('erase-cursor').hidden=true;updateButtons();};
$('result').addEventListener('pointerdown',e=>{
  if(eraseStroke||stroke||e.isPrimary===false||e.button!==0||!ready(active())||showOriginal||saving)return;
  e.preventDefault();const im=active(),rect=$('result').getBoundingClientRect(),bounds=outputBounds(im);
  eraseStroke={imageId:im.id,pointerId:e.pointerId,bounds,radius:eraseSizes[eraseSize]*bounds.width/rect.width/2,path:[]};
  captureErasePoint(e);$('result').setPointerCapture(e.pointerId);moveEraseCursor(e);drawResult();updateButtons();
});
$('result').addEventListener('pointermove',e=>{
  if(eraseStroke&&e.pointerId!==eraseStroke.pointerId)return;
  moveEraseCursor(e);if(!eraseStroke)return;
  e.preventDefault();for(const p of e.getCoalescedEvents?.()||[])captureErasePoint(p);captureErasePoint(e);
  if(!eraseFrame)eraseFrame=requestAnimationFrame(()=>{eraseFrame=0;drawResult();});
});
$('result').addEventListener('pointerup',e=>{
  if(!eraseStroke||e.pointerId!==eraseStroke.pointerId)return;
  e.preventDefault();captureErasePoint(e);finishErase();
});
for(const type of ['pointercancel','lostpointercapture'])$('result').addEventListener(type,e=>{if(e.pointerId===eraseStroke?.pointerId)finishErase();});
$('result').addEventListener('pointerleave',()=>{if(!eraseStroke)$('erase-cursor').hidden=true;});
$('erase-undo').onclick=()=>undo();
$('canvas').addEventListener('pointerdown',e=>{
  if(stroke||e.isPrimary===false||(e.button!==0&&e.button!==2)||!active())return;
  const label=e.button===2||tool==='remove'?0:1;
  if(!label&&!object()){toast('先に残すものを選んでください');return;}
  e.preventDefault();cancelErase();keyboardVisible=false;$('canvas').focus({preventScroll:true});
  stroke={imageId:activeId,pointerId:e.pointerId,label,mode:tool,rect:$('canvas').getBoundingClientRect(),path:[]};
  capturePoint(e);$('canvas').setPointerCapture(e.pointerId);draw();updateButtons();
});
$('canvas').addEventListener('pointermove',e=>{
  if(!stroke||e.pointerId!==stroke.pointerId)return;
  e.preventDefault();for(const p of e.getCoalescedEvents?.()||[])capturePoint(p);capturePoint(e);scheduleStrokeDraw();
});
$('canvas').addEventListener('pointerup',e=>{
  if(!stroke||e.pointerId!==stroke.pointerId)return;
  e.preventDefault();capturePoint(e);const finished=stroke;stroke=null;
  if($('canvas').hasPointerCapture(e.pointerId))$('canvas').releasePointerCapture(e.pointerId);
  if(finished.imageId===activeId)commitStroke(finished.path,finished.label,finished.mode);
});
for(const type of ['pointercancel','lostpointercapture'])$('canvas').addEventListener(type,e=>{if(e.pointerId===stroke?.pointerId)cancelStroke();});
window.addEventListener('blur',()=>{cancelStroke();finishErase();});
$('canvas').addEventListener('contextmenu',e=>e.preventDefault());
$('canvas').addEventListener('keydown',e=>{
  const d=e.shiftKey?.05:.01;
  if(e.key.startsWith('Arrow')){
    e.preventDefault();keyboardVisible=true;
    if(e.key==='ArrowLeft')keyboardPoint.x-=d;if(e.key==='ArrowRight')keyboardPoint.x+=d;if(e.key==='ArrowUp')keyboardPoint.y-=d;if(e.key==='ArrowDown')keyboardPoint.y+=d;
    keyboardPoint.x=Math.max(0,Math.min(1,keyboardPoint.x));keyboardPoint.y=Math.max(0,Math.min(1,keyboardPoint.y));draw();
  }else if((e.key==='Enter'||e.key===' ')&&!stroke){e.preventDefault();addPoint(keyboardPoint.x,keyboardPoint.y);}
});
function undo(){
  if(cancelErase()||cancelStroke())return;
  const im=active();if(!im?.history.length)return;
  const saved=im.history.pop();im.version++;im.objects=saved.objects;im.objectId=saved.objectId;im.erasures=saved.erasures||[];
  for(const [key,item]of pending)if(item.im===im)pending.delete(key);
  if(!im.objects.length)tool='add';recompute(im);renderLibrary();renderObjects();draw();
  for(const o of im.objects)if(o.points.length&&!o.masks)queueObject(im,o);
}
$('undo').onclick=undo;
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&(cancelErase()||cancelStroke()))e.preventDefault();if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'&&!['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)){e.preventDefault();undo();}});
$('reset').onclick=()=>{cancelStroke();cancelErase();const im=active();if(!im)return;saveHistory(im);im.version++;im.objects=[];im.erasures=[];im.objectId=null;im.message='';tool='add';for(const [key,item]of pending)if(item.im===im)pending.delete(key);recompute(im);renderLibrary();renderObjects();draw();status('選択を取り消しました');};
for(const name of ['add','keep','remove'])$('tool-'+name).onclick=()=>setTool(name);
$('refine').onclick=()=>setTool(tool==='add'?'keep':'add');$('refine-done').onclick=()=>setTool('add');
$('finishing').ontoggle=renderCandidates;
$('show-original').onclick=()=>{cancelErase();showOriginal=!showOriginal;updateButtons();draw();};
document.querySelectorAll('[data-bg]').forEach(b=>b.onclick=()=>{background=b.dataset.bg;document.querySelectorAll('[data-bg]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));draw();});
for(const id of ['feather','threshold'])$(id).oninput=()=>{cancelErase();const im=active();if(!im)return;im[id]=Number($(id).value);updateAdjustmentLabels();recompute(im);draw();};
$('threshold').onchange=renderObjects;
$('crop').onchange=()=>{cancelErase();if(active())active().crop=$('crop').checked;draw();};
$('keep-background').onchange=()=>{
  cancelErase();const im=active();if(!im)return;
  im.keepBackground=$('keep-background').checked;
  // Reuse the existing mask. No recompute(), queueObject() or inference request.
  updateButtons();drawResult();
};
$('mp4-fill').oninput=()=>{const im=active();if(im){im.mp4Fill=$('mp4-fill').value;drawResult();}};
new ResizeObserver(()=>draw()).observe($('canvas-area'));
new ResizeObserver(()=>draw()).observe($('result-area'));
for(const id of ['add-images','empty-add'])$(id).onclick=()=>$('file-input').click();
$('file-input').onchange=async()=>{await addFiles(Array.from($('file-input').files));$('file-input').value='';};
document.addEventListener('dragover',e=>{e.preventDefault();document.body.classList.add('dragging');});
document.addEventListener('dragleave',e=>{if(!e.relatedTarget)document.body.classList.remove('dragging');});
document.addEventListener('drop',async e=>{e.preventDefault();document.body.classList.remove('dragging');await addFiles(Array.from(e.dataTransfer.files));});
document.addEventListener('paste',async e=>{const files=Array.from(e.clipboardData?.files||[]);if(files.length){e.preventDefault();await addFiles(files);}});
$('remove-image').onclick=()=>{const im=active();if(!im)return;for(const [key,item]of pending)if(item.im===im)pending.delete(key);images.splice(images.indexOf(im),1);URL.revokeObjectURL(im.url);selectImage(images[0]?.id);};
$('retry').onclick=()=>{if(!bootReady){location.reload();return;}const im=active();for(const o of selectedObjects(im))if(!o.masks)queueObject(im,o);};
function safeName(name) { return name.replace(/\.[^.]+$/,'').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_') || 'image'; }
function outputLayers(im,width,height,bounds=outputBounds(im),live=null,reuse={}) {
  const base=reuse.base||document.createElement('canvas'),mask=reuse.mask||document.createElement('canvas');
  base.width=width;base.height=height;mask.width=width;mask.height=height;
  base.getContext('2d').drawImage(im.img,bounds.x,bounds.y,bounds.width,bounds.height,0,0,width,height);
  if(im.mask){
    const ctx=mask.getContext('2d');
    ctx.drawImage(im.mask,bounds.x/im.width*im.mask.width,bounds.y/im.height*im.mask.height,bounds.width/im.width*im.mask.width,bounds.height/im.height*im.mask.height,0,0,width,height);
    applyErasures(ctx,im.erasures,bounds,width,height);
    if(live)applyErasures(ctx,[live],bounds,width,height);
  }
  return {base,mask:im.mask?mask:null};
}
async function stillBlob(im,format) {
  if(format==='jpeg'&&!canExportJpeg(im))throw Error('透過を含む画像はJPEGに保存できません。WebPかPNGを選択してください。');
  await textureReady;const bounds=outputBounds(im),{width,height}=stillDimensions(bounds,Number($('still-size').value)),layers=outputLayers(im,width,height);
  const c=document.createElement('canvas');c.width=width;c.height=height;
  composeFrame(c.getContext('2d'),{...layers,texture,tile,bounds,imageWidth:im.width,imageHeight:im.height,
    amount:im.glitter,keepBackground:im.keepBackground,phase:im.pngFrame/LOOP_FRAMES});
  layers.base.width=layers.base.height=layers.mask.width=layers.mask.height=1;
  try{return await encodeStill(c,format);}
  finally{c.width=c.height=1;}
}
function mp4Dimensions(bounds){const limit=Number($('mp4-size').value),scale=Math.min(1,limit/Math.max(bounds.width,bounds.height));return {width:Math.max(2,Math.floor(bounds.width*scale/2)*2),height:Math.max(2,Math.floor(bounds.height*scale/2)*2)};}
async function mp4Blob(im) {
  await textureReady;
  if(typeof OffscreenCanvas==='undefined'||typeof createImageBitmap==='undefined')throw Error('このブラウザではMP4保存に対応していません。WebCodecs対応のChrome / Edge等で開いてください。');
  const bounds=outputBounds(im),{width,height}=mp4Dimensions(bounds),amount=im.glitter,imageWidth=im.width,imageHeight=im.height;
  const keepBackground=im.keepBackground,matte=im.mp4Fill,layers=outputLayers(im,width,height);
  let base,mask,textureBitmap;
  try{base=await createImageBitmap(layers.base);mask=await createImageBitmap(layers.mask);textureBitmap=await createImageBitmap(texture);}
  catch(error){base?.close();mask?.close();textureBitmap?.close();throw error;}
  finally{layers.base.width=layers.base.height=layers.mask.width=layers.mask.height=1;}
  return new Promise((resolve,reject)=>{
    let encoder,timer,done=false;
    const finish=(error,bytes)=>{if(done)return;done=true;clearTimeout(timer);encoder?.terminate();cancelExport=null;base.close();mask.close();textureBitmap.close();error?reject(error):resolve(new Blob([bytes],{type:'video/mp4'}));};
    const watch=()=>{clearTimeout(timer);timer=setTimeout(()=>finish(Error('MP4の作成がタイムアウトしました。出力サイズを小さくして再試行してください。')),180000);};
    cancelExport=()=>finish(Error('保存をキャンセルしました'));
    try{
      encoder=new Worker(new URL('./mp4-worker.js?v=glitter-v6',import.meta.url),{type:'module'});
      encoder.onmessage=({data})=>{watch();if(data.type==='progress')status('MP4を作成しています · '+data.value+'%');if(data.type==='done')finish(null,data.bytes);if(data.type==='error')finish(Error(data.message));};
      encoder.onerror=e=>finish(Error(e.message||'MP4を作成できませんでした'));encoder.onmessageerror=()=>finish(Error('MP4データを受信できませんでした'));
      watch();encoder.postMessage({base,mask,texture:textureBitmap,bounds,imageWidth,imageHeight,amount,keepBackground,matte},[base,mask,textureBitmap]);
    }catch(error){finish(error);}
  });
}
const exportBlob=im=>outputFormat==='mp4'?mp4Blob(im):stillBlob(im,outputFormat);
function saveBlob(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}

$('export').onclick=async()=>{
  const im=active();if(!ready(im)||busy)return;saving=true;worker?.terminate();worker=null;clearTimeout(idleWorkerTimer);updateButtons();
  try{const blob=await exportBlob(im);saveBlob(blob,safeName(im.name)+'-glitter.'+outputFormat);toast(outputFormat.toUpperCase()+'を保存しました · '+(blob.size/1_000_000).toFixed(2)+' MB');}catch(e){toast(e.message);}finally{saving=false;cancelExport=null;status('');updateButtons();processQueue();}
};
$('export-batch').onclick=async()=>{
  const selected=images.filter(im=>im.selected&&ready(im));if(!selected.length)return;
  if(outputFormat==='jpeg'&&selected.some(im=>!canExportJpeg(im))){toast('透過を含む画像が選択されています。JPEGは不透明な画像だけを選択してください。');return;}
  if(busy)return;saving=true;worker?.terminate();worker=null;clearTimeout(idleWorkerTimer);updateButtons();
  try{
    const {zipSync}=await import('https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js');const files={};
    for(let i=0;i<selected.length;i++){const im=selected[i];files[String(i+1).padStart(2,'0')+'-'+safeName(im.name)+'-glitter.'+outputFormat]=new Uint8Array(await(await exportBlob(im)).arrayBuffer());}
    saveBlob(new Blob([zipSync(files,{level:0})],{type:'application/zip'}),'glitter-cutouts.zip');toast(selected.length+'枚を保存しました');
  }catch(e){toast(e.message);}finally{saving=false;cancelExport=null;status('');updateButtons();processQueue();}
};
$('cancel-save').onclick=()=>cancelExport?.();
for(const format of ['mp4','webp','png','jpeg'])$('format-'+format).onclick=()=>{outputFormat=format;updateButtons();drawResult();};
$('glitter-opacity').oninput=()=>{const im=active();if(im){im.glitter=Number($('glitter-opacity').value)/100;$('glitter-value').textContent=Math.round(im.glitter*100)+'%';drawResult();}};
$('mp4-size').onchange=drawResult;
$('still-size').onchange=drawResult;
$('preview-play').onclick=()=>{
  if(outputFormat!=='mp4'){const im=active();if(im){im.pngFrame=randomPngFrame(im.pngFrame);drawResult();}}
  else previewPlaying=!previewPlaying;
  updateButtons();
};
function animate(now){
  const elapsed=Math.min(100,now-animationTick);animationTick=now;
  if(!document.hidden&&previewPlaying&&outputFormat==='mp4'&&ready(active())&&!showOriginal&&!eraseStroke&&!saving){
    const previous=Math.floor(animationTime/(1000/LOOP_FPS));animationTime=(animationTime+elapsed)%LOOP_MS;
    if(Math.floor(animationTime/(1000/LOOP_FPS))!==previous)drawResult();
  }
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);
// One-time retirement of this app's previous deployment. This is optional cleanup:
// startup and inference do not wait for, register, or require a Service Worker.
async function retireLegacyWorker(){
  try{
    const sw=navigator.serviceWorker;
    if(!sw?.getRegistrations)return;
    const base=new URL('./',import.meta.url),legacy=new URL('coi-serviceworker.js',base).href;
    const belongsHere=worker=>worker&&new URL(worker.scriptURL).origin+new URL(worker.scriptURL).pathname===legacy;
    const controlled=belongsHere(sw.controller);
    let removed=false;
    for(const registration of await sw.getRegistrations()){
      if(registration.scope===base.href&&[registration.active,registration.waiting,registration.installing].some(belongsHere)){
        removed=(await registration.unregister())||removed;
      }
    }
    // Unregister does not detach the current document. Reload only an untouched
    // editor still controlled by our old worker; never discard imported images.
    if(removed&&controlled&&!images.length)location.reload();
  }catch{/* Storage/worker permissions must never prevent normal startup. */}
}
function boot(){
  bootReady=true;engineError='';$('runtime').textContent='準備完了';processQueue();draw();
  void retireLegacyWorker();
}
renderLibrary();renderObjects();boot();

