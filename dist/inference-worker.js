let detector=null;
self.onmessage=async({data})=>{
  if(data.type==='load') {
    try {
      importScripts('./vendor/tf.min.js','./vendor/coco-ssd.min.js','./vendor/tf-backend-wasm.js');
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
      const results=await detector.detect(tensor,10,.5);
      self.postMessage({type:'result',id:data.id,results,ms:performance.now()-started});
    } catch(error) { self.postMessage({type:'inference-error',id:data.id,message:String(error.message||error)}); }
    finally { if(tensor)tensor.dispose(); }
  }
};
