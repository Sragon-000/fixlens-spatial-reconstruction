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
  function scanTiles(width,height,roi,columns=3,rows=3) {
    const x=Math.max(0,Math.min(width-1,Math.floor(roi.x)));
    const y=Math.max(0,Math.min(height-1,Math.floor(roi.y)));
    const right=Math.max(x+1,Math.min(width,Math.ceil(roi.x+roi.w)));
    const bottom=Math.max(y+1,Math.min(height,Math.ceil(roi.y+roi.h)));
    const regionWidth=right-x,regionHeight=bottom-y;
    const tileWidth=Math.min(regionWidth,Math.ceil(regionWidth*(1/columns+.1)));
    const tileHeight=Math.min(regionHeight,Math.ceil(regionHeight*(1/rows+.1)));
    const stepX=columns===1?0:(regionWidth-tileWidth)/(columns-1);
    const stepY=rows===1?0:(regionHeight-tileHeight)/(rows-1);
    const tiles=[];
    for(let row=0;row<rows;row++)for(let column=0;column<columns;column++) {
      const tileX=Math.min(right-tileWidth,Math.round(x+column*stepX));
      const tileY=Math.min(bottom-tileHeight,Math.round(y+row*stepY));
      tiles.push({index:row*columns+column,x:tileX,y:tileY,w:tileWidth,h:tileHeight});
    }
    return tiles;
  }
  function merge(predictions,limit=50) {
    const kept=[];
    for(const p of [...predictions].sort((a,b)=>b.score-a.score)) {
      if(!kept.some(q=>q.class===p.class&&overlap(q.bbox,p.bbox)>.45))kept.push(p);
      if(kept.length>=limit)break;
    }
    return kept;
  }
  return {overlap,regions,scanTiles,merge};
})();
