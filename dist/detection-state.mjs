export class DetectionState {
  constructor() { this.epoch=0; this.sequence=0; this.pending=null; this.clear(); }
  clear() { this.epoch++; this.results=[]; this.receivedAt=-Infinity; this.capturedAt=-Infinity; }
  begin(now,width,height) {
    if(this.pending) return null;
    this.pending={id:++this.sequence,epoch:this.epoch,capturedAt:now,width,height};
    return {...this.pending};
  }
  accept(message,now) {
    if(!this.pending || message.id!==this.pending.id) return false;
    const job=this.pending; this.pending=null;
    if(job.epoch!==this.epoch || now-job.capturedAt>2000) return false;
    const previous=now-this.receivedAt<=650?this.results:[];
    const candidates=(message.results||[]).filter(p=>Array.isArray(p.bbox)&&p.bbox.length===4&&p.bbox.every(Number.isFinite)&&Number.isFinite(p.score)&&p.score>=.35).map(p=>{
      const [x,y,w,h]=p.bbox;
      const left=Math.max(0,Math.min(1,x/job.width)),top=Math.max(0,Math.min(1,y/job.height));
      const right=Math.max(left,Math.min(1,(x+w)/job.width)),bottom=Math.max(top,Math.min(1,(y+h)/job.height));
      return {name:String(p.class),score:p.score,x:left,y:top,w:right-left,h:bottom-top,lastSeenAt:now,held:false};
    }).filter(p=>p.w>0&&p.h>0);
    const matched=new Set();
    this.results=candidates.map(p=>{
      let best=-1,bestIou=.3;
      previous.forEach((q,i)=>{
        if(matched.has(i)||q.name!==p.name)return;
        const area=Math.max(0,Math.min(p.x+p.w,q.x+q.w)-Math.max(p.x,q.x))*Math.max(0,Math.min(p.y+p.h,q.y+q.h)-Math.max(p.y,q.y));
        const iou=area/(p.w*p.h+q.w*q.h-area)||0;
        if(iou>bestIou){best=i;bestIou=iou;}
      });
      if(best<0)return p;
      matched.add(best);const q=previous[best];
      return {...p,...Object.fromEntries(['x','y','w','h'].map(k=>[k,p[k]*.75+q[k]*.25]))};
    });
    if(candidates.length)previous.forEach((q,i)=>{
      if(matched.has(i)||now-q.lastSeenAt>250)return;
      // Do not retain a second label on an object already detected again.
      if(candidates.some(p=>Math.max(p.x,q.x)<Math.min(p.x+p.w,q.x+q.w)&&Math.max(p.y,q.y)<Math.min(p.y+p.h,q.y+q.h)))return;
      this.results.push({...q,held:true});
    });
    this.results=this.results.slice(0,50);
    this.receivedAt=now;this.capturedAt=job.capturedAt;return true;
  }
  visible(now) { return now-this.receivedAt<=650 && now-this.capturedAt<=2000 ? this.results.filter(p=>!p.held||now-p.lastSeenAt<=250) : []; }
}
