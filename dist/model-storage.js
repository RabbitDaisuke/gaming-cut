// Persistent Cache Storage used directly by the inference workers; no SW proxy.
const IMGLY_BASE='https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/';
const SAM_PREFIX='/Xenova/slimsam-77-uniform/resolve/5850ab45f587c112167512ffef949107115e26a0/';
async function openCache(name){try{return await globalThis.caches?.open(name);}catch{return undefined;}}

export function cacheImglyDownloads(){
  const networkFetch=globalThis.fetch.bind(globalThis),cacheReady=openCache('glitter-imgly-1.7.0');
  let active=0;const queue=[];
  async function acquire(){if(active<2){active++;return;}await new Promise(resolve=>queue.push(resolve));}
  function release(){const next=queue.shift();if(next)next();else active--;}
  globalThis.fetch=async(input,init)=>{
    const request=new Request(input,init);
    if(request.method!=='GET'||!request.url.startsWith(IMGLY_BASE))return networkFetch(input,init);
    await acquire();
    const cache=await cacheReady,name=request.url.slice(IMGLY_BASE.length);
    const verify=async response=>{
      if(name==='resources.json')return response;
      if(!/^[a-f0-9]{64}$/.test(name))throw Error('Unexpected IMG.LY resource');
      const bytes=await response.arrayBuffer(),digest=await crypto.subtle.digest('SHA-256',bytes);
      if(Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('')!==name)throw Error('IMG.LY resource checksum mismatch');
      return new Response(bytes,{headers:response.headers,status:response.status});
    };
    try{
      // Preserve the same cache name and request keys used by earlier versions.
      try{const saved=await cache?.match(request);if(saved)return await verify(saved);}catch{/* Retry this resource; do not clear stored caches. */}
      const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),45000);
      try{
        const response=await networkFetch(request,{signal:abort.signal});
        if(!response.ok)throw Error('IMG.LY resource HTTP '+response.status);
        const result=await verify(response);
        try{await cache?.put(request,result.clone());}catch(error){console.warn('モデルを保存できません:',error.message);}
        return result;
      }finally{clearTimeout(timer);}
    }finally{release();}
  };
}

export function createSamCache(){
  const standardReady=openCache('transformers-cache');
  return {
    async match(request){
      const standard=await standardReady;
      try{const saved=await standard?.match(request);if(saved)return saved;}catch{}
      const url=new URL(typeof request==='string'?request:request.url,import.meta.url);
      if(url.origin!=='https://huggingface.co'||!url.pathname.startsWith(SAM_PREFIX))return undefined;
      const legacy=await openCache('glitter-slimsam-parts-v1');if(!legacy)return undefined;
      const key=new URL('./',import.meta.url).href+'__model_parts__/'+encodeURIComponent(url.pathname.slice(1))+'/';
      try{
        const record=await legacy.match(key+'manifest');if(!record)return undefined;
        const manifest=await record.json();
        const specs={
          'onnx/vision_encoder.onnx':[23276014,'66ab8e4a5a44439c'],
          'onnx/prompt_encoder_mask_decoder.onnx':[16557892,'cc11b9de008291cb']
        };
        const spec=specs[url.pathname.slice(SAM_PREFIX.length)];
        if(!Number.isInteger(manifest.parts)||manifest.parts<1||manifest.parts>100||manifest.partBytes!==50_000_000)return undefined;
        if(spec&&(manifest.total!==spec[0]||manifest.hash!==spec[1]))return undefined;
        const {createXXHash64}=await import('https://cdn.jsdelivr.net/npm/hash-wasm@4.12.0/+esm');
        const hasher=await createXXHash64();hasher.init();const chunks=[];let total=0;
        for(let i=0;i<manifest.parts;i++){
          const part=await legacy.match(key+i);if(!part)return undefined;
          const bytes=new Uint8Array(await part.arrayBuffer());hasher.update(bytes);total+=bytes.length;chunks.push(bytes);
        }
        if(total!==manifest.total||hasher.digest()!==manifest.hash)return undefined;
        return new Response(new Blob(chunks),{headers:{'Content-Length':String(total),'Content-Type':url.pathname.endsWith('.json')?'application/json':'application/octet-stream'}});
      }catch{return undefined;}
    },
    async put(request,response){const cache=await standardReady;if(cache)await cache.put(request,response);}
  };
}
