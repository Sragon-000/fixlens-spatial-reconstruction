let detector=null;
self.onmessage=async({data})=>{
  if(data.type==='load') {
    try {
      importScripts('./vendor/tf.min.js','./vendor/coco-ssd.min.js','./vendor/tf-backend-wasm.js','./detection-utils.js');
      let accelerated=false;
      tf.wasm.setWasmPaths(new URL('./vendor/',self.location.href).href);
      tf.wasm.setThreadsCount(1);
      try { accelerated=await tf.setBackend('wasm'); } catch(_) {}
      if(!accelerated)try { accelerated=await tf.setBackend('webgl'); } catch(_) {}
      if(!accelerated) await tf.setBackend('cpu');
      await tf.ready();
      detector=await cocoSsd.load({base:'lite_mobilenet_v2',modelUrl:new URL('./model/model.json',self.location.href).href});
      self.postMessage({type:'ready',backend:tf.getBackend()});
    } catch(error) { self.postMessage({type:'load-error',message:String(error.message||error)}); }
  } else if(data.type==='detect' && detector) {
    let tensor;
    try {
      tensor=tf.browser.fromPixels({data:new Uint8Array(data.pixels),width:data.width,height:data.height});
      const started=performance.now();
      const predictions=[];
      for(const region of DetectionUtils.regions(data.width,data.height,Boolean(data.detail))) {
        const crop=tf.slice(tensor,[region.y,region.x,0],[region.h,region.w,3]);
        try {
          const found=await detector.detect(crop,50,.35);
          predictions.push(...found.map(p=>({...p,bbox:[p.bbox[0]+region.x,p.bbox[1]+region.y,p.bbox[2],p.bbox[3]]})));
        } finally { crop.dispose(); }
      }
      const results=DetectionUtils.merge(predictions);
      self.postMessage({type:'result',id:data.id,results,ms:performance.now()-started});
    } catch(error) { self.postMessage({type:'inference-error',id:data.id,message:String(error.message||error)}); }
    finally { if(tensor)tensor.dispose(); }
  }
};
