globalThis.DetectionUtils = (() => {
  function overlap(a,b) {
    const [x,y,w,h]=a,[u,v,s,t]=b;
    const area=Math.max(0,Math.min(x+w,u+s)-Math.max(x,u))*Math.max(0,Math.min(y+h,v+t)-Math.max(y,v));
    return area/(w*h+s*t-area)||0;
  }
  function regions(width,height,detail) {
    const all=[{x:0,y:0,w:width,h:height}];
    if(!detail)return all;
    const w=Math.ceil(width*.6),h=Math.ceil(height*.6);
    for(const y of [0,height-h])for(const x of [0,width-w])all.push({x,y,w,h});
    return all;
  }
  function merge(predictions,limit=50) {
    const kept=[];
    for(const p of [...predictions].sort((a,b)=>b.score-a.score)) {
      if(!kept.some(q=>q.class===p.class&&overlap(q.bbox,p.bbox)>.45))kept.push(p);
      if(kept.length>=limit)break;
    }
    return kept;
  }
  return {overlap,regions,merge};
})();
