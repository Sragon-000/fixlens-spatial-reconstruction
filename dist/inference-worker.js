let detector=null;
self.onmessage=async({data})=>{
  if(data.type==='load') {
    try {
      // TensorFlow.js otherwise falls back to a dynamic Function() to install
      // regeneratorRuntime, which the app's CSP intentionally blocks.
      self.regeneratorRuntime = self.regeneratorRuntime || undefined;
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
  } else if(data.type==='scan' && detector) {
    let tensor;
    const started=performance.now();
    try {
      tensor=tf.browser.fromPixels({data:new Uint8Array(data.pixels),width:data.width,height:data.height});
      const tiles=DetectionUtils.scanTiles(data.width,data.height,data.roi);
      const indices=Array.isArray(data.tileIndices)?data.tileIndices:tiles.map(tile=>tile.index);
      self.postMessage({type:'scan-start',id:data.id,total:tiles.length,indices});
      for(const index of indices) {
        const tile=tiles[index];
        if(!tile)continue;
        self.postMessage({type:'scan-tile-start',id:data.id,index,total:tiles.length});
        let crop;
        try {
          crop=tf.slice(tensor,[tile.y,tile.x,0],[tile.h,tile.w,3]);
          const found=await detector.detect(crop,50,.35);
          const results=found.map(item=>({
            class:String(item.class),score:item.score,
            bbox:[
              (tile.x+item.bbox[0])/data.width,
              (tile.y+item.bbox[1])/data.height,
              item.bbox[2]/data.width,
              item.bbox[3]/data.height,
            ],
          }));
          self.postMessage({type:'scan-tile-result',id:data.id,index,results,ms:performance.now()-started});
        } catch(error) {
          self.postMessage({type:'scan-tile-error',id:data.id,index,message:String(error.message||error)});
        } finally { if(crop)crop.dispose(); }
      }
      self.postMessage({type:'scan-done',id:data.id,indices,ms:performance.now()-started});
    } catch(error) {
      self.postMessage({type:'scan-error',id:data.id,message:String(error.message||error)});
    } finally { if(tensor)tensor.dispose(); }
  }
};
