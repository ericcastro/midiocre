"use client";
import { useMemo, useRef, useState } from "react";
import { matchNotes, type Passage, type ReviewNote } from "../lib/youtubeReview";

const W = 1100, H = 528, LABEL = 38;
const colors = { same: "#829da5", added: "#4bd6a0", removed: "#f87c85", timing: "#f6c667", pitch: "#64b7ff", ambiguous: "#c3a0ef" };
export function ReviewPianoRoll({ before, after, mode, view, position, selected, onSelect, onEdit, onSeek, editable, beats = [] }: {
  before: ReviewNote[]; after: ReviewNote[]; mode: "baseline" | "candidate" | "difference";
  view: Passage; position: number; selected: Set<string>; onSelect: (ids: Set<string>) => void;
  onEdit: (notes: ReviewNote[], label: string) => void; onSeek: (position: number) => void; editable: boolean; beats?: { time: number; label: string }[];
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ x: number; y: number; note?: ReviewNote; resize?: boolean; ids: Set<string>; nowX: number; nowY: number } | null>(null);
  const limits = [...before,...after].reduce((range,n)=>({low:Math.min(range.low,n.pitch),high:Math.max(range.high,n.pitch)}),{low:48,high:72});
  const low = Math.max(21, limits.low-4);
  const high = Math.min(108, limits.high+4);
  const ROW = H/(high-low+1);
  const matches = useMemo(() => matchNotes(before,after),[before,after]);
  const x = (t: number) => LABEL + (t-view.start)/(view.end-view.start)*(W-LABEL);
  const y = (p: number) => (high-p)*ROW;
  const coords = (e: React.PointerEvent | React.MouseEvent) => { const r = svg.current!.getBoundingClientRect(); return { x: (e.clientX-r.left)/r.width*W, y: (e.clientY-r.top)/r.height*H }; };
  const visible = (n: ReviewNote) => n.end > view.start && n.start < view.end;
  const selectedNotes = before.filter(n => selected.has(n.id));
  const dx = drag ? (drag.nowX-drag.x)/(W-LABEL)*(view.end-view.start) : 0;
  const dy = drag ? -Math.round((drag.nowY-drag.y)/ROW) : 0;
  function commitDrag() {
    if (!drag) return;
    if (drag.note && editable && (Math.abs(dx)>.008 || dy)) {
      const bounds = selectedNotes.reduce((b,n)=>({start:Math.min(b.start,n.start),low:Math.min(b.low,n.pitch),high:Math.max(b.high,n.pitch)}),{start:Infinity,low:108,high:21});
      const delta = Math.max(-bounds.start,dx);
      const pitchDelta = Math.max(21-bounds.low,Math.min(108-bounds.high,dy));
      onEdit(before.map(n => drag.ids.has(n.id) ? drag.resize ? { ...n, end: Math.max(n.start+.02,n.end+dx) } : { ...n, start: n.start+delta, end: n.end+delta, pitch: n.pitch+pitchDelta } : n),drag.resize ? "Resize notes" : "Move notes");
    } else if (!drag.note && Math.abs(drag.nowX-drag.x)>3) {
      onSelect(new Set(before.filter(n => x(n.end)>=Math.min(drag.x,drag.nowX) && x(n.start)<=Math.max(drag.x,drag.nowX) && y(n.pitch)+ROW>=Math.min(drag.y,drag.nowY) && y(n.pitch)<=Math.max(drag.y,drag.nowY)).map(n=>n.id)));
    } else if (!drag.note) { onSelect(new Set()); onSeek(Math.max(0,view.start+(drag.x-LABEL)/(W-LABEL)*(view.end-view.start))); }
    setDrag(null);
  }
  const draw = (n: ReviewNote, color: string, outline: boolean, key: string) => {
    if (!visible(n)) return null;
    const active = selected.has(n.id) && !outline && mode === "baseline";
    const preview = active && drag?.note ? { ...n, start: n.start+(drag.resize ? 0 : dx), end: n.end+dx, pitch: n.pitch+(drag.resize ? 0 : dy) } : n;
    const left = Math.max(LABEL,x(preview.start)), right = Math.min(W,x(preview.end));
    return <rect key={key} x={left} y={y(preview.pitch)+.5} width={Math.max(2,right-left)} height={ROW-1} fill={outline ? "none" : color} fillOpacity={outline ? 1 : .8} stroke={active ? "white" : color} strokeWidth={active ? 2 : 1} strokeDasharray={n.boundary ? "2 2" : undefined}
      onPointerDown={e => {
        e.stopPropagation();
        if (!editable || mode !== "baseline") { onSeek(n.start); return; }
        const p = coords(e), ids = e.shiftKey ? new Set(selected) : selected.has(n.id) ? new Set(selected) : new Set<string>();
        if (e.shiftKey && ids.has(n.id)) ids.delete(n.id); else ids.add(n.id);
        onSelect(ids); svg.current!.setPointerCapture(e.pointerId);
        setDrag({ ...p, nowX:p.x, nowY:p.y, note:n, resize: Math.abs(p.x-right)<8 || e.altKey, ids });
      }}><title>{n.instrument.replaceAll("_"," ")} · MIDI {n.pitch} · {n.start.toFixed(3)}–{n.end.toFixed(3)}s{n.boundary ? " · may touch inference context edge" : ""}</title></rect>;
  };
  return <div className="review-roll" tabIndex={0} aria-label="Review piano roll. Shift click or drag to select notes. Drag a note to move, its right edge to resize. Double click empty space to add."
    onKeyDown={e => {
      if (!editable || mode !== "baseline") return;
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); onEdit(before.filter(n=>!selected.has(n.id)),"Delete notes"); }
      if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(e.key) && selected.size) {
        e.preventDefault(); const pitch = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0, delta = e.key === "ArrowRight" ? .05 : e.key === "ArrowLeft" ? -.05 : 0;
        onEdit(before.map(n=>selected.has(n.id) ? {...n,pitch:Math.max(21,Math.min(108,n.pitch+pitch)),start:Math.max(0,n.start+delta),end:n.end+Math.max(-n.start,delta)} : n),"Nudge notes");
      }
    }}>
    <svg ref={svg} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Aligned transcription notes, pitch vertically and source seconds horizontally"
      onPointerDown={e => { const p=coords(e); svg.current!.setPointerCapture(e.pointerId); setDrag({...p,nowX:p.x,nowY:p.y,ids:new Set()}); }}
      onPointerMove={e => { if (drag) { const p=coords(e); setDrag({...drag,nowX:p.x,nowY:p.y}); } }} onPointerUp={commitDrag} onPointerCancel={()=>setDrag(null)}
      onDoubleClick={e => { if (!editable || mode !== "baseline" || e.target !== e.currentTarget) return; const p=coords(e), start=Math.max(0,view.start+(p.x-LABEL)/(W-LABEL)*(view.end-view.start)); onEdit([...before,{id:crypto.randomUUID(),pitch:Math.max(21,Math.min(108,high-Math.floor(p.y/ROW))),start,end:start+.3,instrument:"acoustic_piano",boundary:false}],"Add note"); }}>
      {Array.from({length:high-low+1},(_,i)=>{const pitch=high-i; return <g key={pitch} pointerEvents="none"><rect x={0} y={i*ROW} width={W} height={ROW} fill={[1,3,6,8,10].includes(pitch%12)?"#192427":"#233236"}/><line x1={LABEL} x2={W} y1={i*ROW} y2={i*ROW} stroke="#33464a" strokeWidth=".4"/>{pitch%12===0&&<text x="4" y={i*ROW+ROW} fill="#b0c0bd" fontSize="7">C{pitch/12-1}</text>}</g>;})}
      {Array.from({length:11},(_,i)=>{const t=view.start+i*(view.end-view.start)/10;return <g key={i} pointerEvents="none"><line x1={x(t)} x2={x(t)} y1="0" y2={H} stroke="#728581" strokeOpacity=".3"/><text x={x(t)+2} y="11" fill="#cedbd7" fontSize="9">{t.toFixed(1)}s</text></g>;})}
      {beats.filter(b=>b.time>=view.start&&b.time<=view.end).map((b,i)=><g key={i} pointerEvents="none"><line x1={x(b.time)} x2={x(b.time)} y1="15" y2={H} stroke="#a5c2b9" strokeDasharray="2 4"/><text x={x(b.time)+2} y="23" fill="#a5c2b9" fontSize="8">{b.label}</text></g>)}
      {mode === "baseline" ? before.map(n=>draw(n,"#91ccb8",false,n.id)) : mode === "candidate" ? after.map(n=>draw(n,"#91b9ef",false,n.id)) : matches.flatMap((m,i)=>[
        m.before && draw(m.before,colors[m.kind],true,`b${i}`),m.after && draw(m.after,colors[m.kind],false,`a${i}`),
        m.before && m.after && m.kind!=="same" && visible(m.before) && <line key={`l${i}`} pointerEvents="none" x1={x(m.before.start)} y1={y(m.before.pitch)+ROW/2} x2={x(m.after.start)} y2={y(m.after.pitch)+ROW/2} stroke={colors[m.kind]}/>,
      ])}
      {position>=view.start&&position<=view.end&&<line pointerEvents="none" x1={x(position)} x2={x(position)} y1="0" y2={H} stroke="white" strokeWidth="1.5"/>}
      {drag&&!drag.note&&<rect pointerEvents="none" x={Math.min(drag.x,drag.nowX)} y={Math.min(drag.y,drag.nowY)} width={Math.abs(drag.nowX-drag.x)} height={Math.abs(drag.nowY-drag.y)} fill="#ffffff22" stroke="white"/>}
    </svg>
  </div>;
}
