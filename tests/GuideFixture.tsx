import React, {useRef, useState} from "react";
import UserGuide from "../src/components/UserGuide";

/** Opt-in actual-page harness. Existing regressions keep their original render path. */
export default function GuideFixture({chapter, children}: {chapter: string; children: (reading: boolean) => React.ReactNode}) {
  const [reading,setReading]=useState(false),background=useRef<HTMLDivElement>(null);
  return <><div ref={background} className="h-full min-h-0">{children(reading)}</div>
    <button type="button" style={{position:"fixed",right:12,top:6,zIndex:60,padding:"8px 12px",border:"1px solid #c3aa78",borderRadius:6,background:"#203746",color:"#ffe1a0"}} onClick={()=>setReading(true)}>Read User Guide</button>
    {reading&&<UserGuide chapter={chapter} onClose={()=>setReading(false)} background={background.current}/>}</>;
}
