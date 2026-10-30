"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, Video, Play, Pause, Undo2, Redo2 } from "lucide-react";
import { API_BASE, reviewApi } from "../lib/api";
import type { SongDetail } from "../lib/types";
import { hasCorrections, mergeNotes, reviewedNotes, type InferenceSettings, type Passage, type PracticeSettings, type ReviewNote, type ReviewSession, type ReviewVersion } from "../lib/youtubeReview";
import { ReviewTransport } from "../lib/reviewTransport";
import { ReviewPianoRoll } from "./ReviewPianoRoll";

const defaults: InferenceSettings = { model:"small", instruments:"piano", beam_size:1 };
const practiceDefaults: PracticeSettings = { bpm:null, beats_per_bar:null, first_downbeat:null, tempo_map:null, quantize:false, subdivision:4, strength:1 };
const steps = ["Source & passage","Compare experiments","Correct & prepare","Confirm import"];
const EMPTY: ReviewNote[] = [];
function settingsLabel(v: ReviewVersion | undefined) { return v ? `${v.settings.model} · ${v.settings.instruments === "piano" ? "acoustic piano only" : "all detected instruments"} · search ${v.settings.beam_size} · ${v.full ? "full recording" : `${v.passage.start.toFixed(1)}–${v.passage.end.toFixed(1)}s passage`} · ${v.processing_seconds.toFixed(1)}s processing${v.cached ? " (cached)" : ""}` : "No accepted result yet"; }

export function YouTubeImport({onClose,onImported}: {onClose:()=>void;onImported:(song:SongDetail)=>void}) {
  const [session,setSession] = useState<ReviewSession|null>(null);
  const current = useRef<ReviewSession|null>(null);
  const [reviews,setReviews] = useState<{id:string;title:string;imported_song_id?:string}[]>([]);
  const [url,setUrl] = useState("");
  const [step,setStep] = useState(0);
  const [error,setError] = useState("");
  const [busy,setBusy] = useState(false);
  const [settings,setSettings] = useState(defaults);
  const [practice,setPractice] = useState(practiceDefaults);
  const [passage,setPassage] = useState<Passage>({start:0,end:20});
  const [view,setView] = useState<Passage>({start:0,end:20});
  const [mode,setMode] = useState<"baseline"|"candidate"|"difference">("difference");
  const [audition,setAudition] = useState<"baseline"|"candidate"|"practice">("baseline");
  const [selected,setSelected] = useState<Set<string>>(new Set());
  const [archive,setArchive] = useState(false);
  const [merge,setMerge] = useState(false);
  const [position,setPosition] = useState(0);
  const [playing,setPlaying] = useState(false);
  const [loop,setLoop] = useState(true);
  const [audioLevel,setAudioLevel] = useState(.7);
  const [midiLevel,setMidiLevel] = useState(.8);
  const [listen,setListen] = useState<"audio"|"midi"|"both">("midi");
  const [audioReady,setAudioReady] = useState(false);
  const [loadingAudio,setLoadingAudio] = useState(false);
  const [title,setTitle] = useState("");
  const [confirmed,setConfirmed] = useState(false);
  const transport = useRef<ReviewTransport|null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(()=>{bodyRef.current?.scrollTo({top:0});},[step]);
  const sourceId = session?.source ? session.id : null;
  const receive = useCallback((incoming: ReviewSession) => {
    if (current.current && incoming.id===current.current.id && incoming.revision < current.current.revision) return;
    if (!current.current?.source && incoming.source) {
      setPassage(incoming.passage); setView(incoming.passage); setTitle(incoming.source.title.slice(0,160));
    }
    if (incoming.prepared && incoming.prepared.id !== current.current?.prepared?.id) setAudition("practice");
    else if (!incoming.baseline && incoming.candidate) setAudition("candidate");
    if (incoming.candidate && incoming.candidate !== current.current?.candidate) setMode(incoming.baseline?"difference":"candidate");
    current.current=incoming; setSession(incoming);
  },[]);
  const initialize = useCallback((s:ReviewSession)=>{receive(s);setSettings(s.settings);setPractice(s.practice);setPassage(s.passage);setView(s.passage);setTitle(s.source?.title.slice(0,160)||"");setSelected(new Set());setConfirmed(false);},[receive]);
  useEffect(()=>{void reviewApi<typeof reviews>("/reviews").then(setReviews).catch(e=>setError(String(e)));},[]);
  const jobStatus = session?.job?.status;
  useEffect(()=>{
    if (!session?.id) return;
    let disposed=false;
    const id=session.id;
    const active=["queued","running"].includes(jobStatus||"");
    const timer=setInterval(()=>{void reviewApi<ReviewSession>(`/reviews/${id}`).then(s=>{if(!disposed) receive(s);}).catch(e=>{if(!disposed)setError(String(e));});},active?900:5000);
    return ()=>{disposed=true;clearInterval(timer);};
  },[session?.id,jobStatus,receive]);
  useEffect(()=>{
    const t=new ReviewTransport(); transport.current=t;
    t.onPosition=(p,active)=>{setPosition(p);setPlaying(active);};
    return ()=>{t.dispose();transport.current=null;};
  },[sourceId]);
  const baseline = session?.baseline ? session.versions[session.baseline] : undefined;
  const candidate = session?.candidate ? session.versions[session.candidate] : undefined;
  const notes = useMemo(()=>session?reviewedNotes(session):EMPTY,[session]);
  const auditionData = JSON.stringify(audition === "candidate" ? candidate?.notes||EMPTY : audition === "practice" ? session?.prepared?.notes||EMPTY : notes);
  // Polling progress must never restart an unchanged audio schedule.
  const auditionNotes = useMemo<ReviewNote[]>(()=>JSON.parse(auditionData),[auditionData]);
  const validPassage = passage.start >= 0 && passage.end-passage.start >= .25 && passage.end <= (session?.source?.duration || 20);
  useEffect(()=>{transport.current?.configure(auditionNotes,loop && validPassage ? passage : null);},[auditionNotes,loop,passage,sourceId,validPassage]);
  useEffect(()=>{transport.current?.levels(listen==="midi"?0:audioLevel,listen==="audio"?0:midiLevel);},[audioLevel,midiLevel,listen,audioReady]);
  const working = !!session?.job && ["queued","running"].includes(session.job.status);
  const dirty = !!session && JSON.stringify({settings,passage,practice})!==JSON.stringify({settings:session.settings,passage:session.passage,practice:session.practice});
  const candidateStale = candidate && (JSON.stringify(candidate.settings)!==JSON.stringify(settings)||(!candidate.full&&JSON.stringify(candidate.passage)!==JSON.stringify(passage)));
  const corrected = session ? hasCorrections(session) : false;
  async function action(path:string,body:Record<string,unknown>={},s=current.current) {
    if (!s) throw new Error("Open a source first.");
    const next=await reviewApi<ReviewSession>(`/reviews/${s.id}/${path}`,{revision:s.revision,...body}); receive(next);return next;
  }
  async function safely(fn:()=>Promise<void>) { if(busy)return;setBusy(true);setError("");try{await fn();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);} }
  async function saveChoices() {
    const s=current.current!;
    const next=await reviewApi<ReviewSession>(`/reviews/${s.id}/configuration`,{revision:s.revision,settings,passage,practice},"PUT"); receive(next);return next;
  }
  const edit = (next:ReviewNote[],label:string) => { void safely(async()=>{await action("edits",{notes:next,label});setConfirmed(false);}); };
  async function run(full:boolean) { await safely(async()=>{const s=await saveChoices();await action("transcribe",{full},s);setStep(1);}); }
  async function togglePlayback() {
    try {
      setError("");
      if (playing) {transport.current?.pause();return;}
      if (!audioReady) {
        setLoadingAudio(true);
        await transport.current!.load(`${API_BASE}/api/youtube/reviews/${session!.id}/audio`);
        setAudioReady(true);
        transport.current!.configure(auditionNotes,loop&&validPassage?passage:null);
        transport.current!.levels(listen==="midi"?0:audioLevel,listen==="audio"?0:midiLevel);
      }
      await transport.current!.play();
    } catch(e) {setError(e instanceof Error?e.message:String(e));} finally {setLoadingAudio(false);}
  }
  const duration=session?.source?.duration||20;
  const one=selected.size===1?notes.find(n=>selected.has(n.id)):undefined;
  const beats=useMemo(()=>{
    if(step===3&&session?.prepared)return session.prepared.bars.map(b=>({time:b.start_seconds-session.prepared!.source_offset,label:`bar ${b.bar}`}));
    const grid=baseline?.grid;
    if(!grid)return [];
    return (grid.beats||[]).map((time,i)=>({time,label:grid.beats_per_bar&&i%grid.beats_per_bar===0?"beat":""}));
  },[baseline,session,step]);
  return <div className="modal-backdrop youtube-backdrop">
    <section className="youtube-review" role="dialog" aria-modal="true" aria-labelledby="youtube-title" onKeyDown={e=>{
      if (step!==2||busy||!(e.metaKey||e.ctrlKey)||e.key.toLowerCase()!=="z"||(e.target as HTMLElement).closest("input,textarea,select")) return;
      const direction=e.shiftKey?"redo":"undo";
      if (!session || (direction==="undo"?session.edit_cursor===0:session.edit_cursor>=session.edits.length-1)) return;
      e.preventDefault();void safely(async()=>{await action(`history/${direction}`);});
    }}>
      <header className="modal-header"><div><span className="eyebrow">Listen · compare · correct</span><h2 id="youtube-title"><Video size={23}/> Import from YouTube</h2></div><button className="quiet-icon" aria-label="Save and close review" disabled={busy} onClick={()=>void safely(async()=>{if(session?.source&&dirty)await saveChoices();onClose();})}><X size={20}/></button></header>
      <nav className="review-steps" aria-label="Import steps">{steps.map((name,i)=><button key={name} className={step===i?"active":""} disabled={i>0&&!session?.source} onClick={()=>{setStep(i);if(i===2)setAudition("baseline");if(i===3&&session?.prepared)setAudition("practice");}}><b>{i+1}</b> {name}</button>)}</nav>
      <div className="review-body" ref={bodyRef}>
      {error&&<p className="analysis-error" role="alert">{error}</p>}
      {session?.source&&!validPassage&&<p className="analysis-error">Choose an end at least 0.25 seconds after the start, inside the source recording. Looping is paused until the range is valid.</p>}
      {session?.job&&<div className="review-job" role="status"><span>{session.job.phase} · {session.job.elapsed.toFixed(1)}s{session.job.total?` · ${session.job.completed||0}/${session.job.total} chunks`:""}</span>{working&&<><progress max={session.job.total||undefined} value={session.job.total?session.job.completed:undefined}/><button onClick={()=>void safely(async()=>{await action("cancel");})}>Cancel job</button></>}{session.job.error&&<p className="analysis-error">{session.job.error}</p>}</div>}
      {step===0&&<>
        {!session&&<div className="review-source-entry"><h3>Start with a performance</h3><p>Keep the original audio, test a short passage, then review the full transcription before importing it.</p><label className="field"><span>YouTube video URL</span><input placeholder="https://www.youtube.com/watch?v=…" value={url} onChange={e=>setUrl(e.target.value)}/></label><button className="primary-action" disabled={busy||!url.trim()} onClick={()=>void safely(async()=>{const s=await reviewApi<ReviewSession>("/reviews",{url});initialize(s);})}>Get source audio</button>
        {reviews.length>0&&<div className="review-resume"><h3>Resume a review</h3>{reviews.map(r=><button key={r.id} onClick={()=>void safely(async()=>{initialize(await reviewApi<ReviewSession>(`/reviews/${r.id}`));})}>{r.title}{r.imported_song_id?" · previously imported":""}</button>)}</div>}</div>}
        {session&&!session.source&&!working&&<button onClick={()=>void safely(async()=>{await action("retry-download");})}>Retry source download</button>}
        {session?.source&&<><h3>{session.source.title}</h3><p>{session.source.uploader} · {duration.toFixed(1)} seconds · original stream retained · playback decoded at {session.source.sample_rate} Hz</p><p><a href={`${API_BASE}/api/youtube/reviews/${session.id}/original`} download>Save original audio</a></p><h3>Choose a test passage</h3><p>Drag across this timeline to select a passage. Navigation never runs transcription. Start with 10–30 seconds that include the notes you want to inspect.</p>
        <PassageTimeline duration={duration} passage={passage} onChange={setPassage}/>
        <div className="review-controls"><label>Start (s)<input aria-label="Passage start" type="number" min="0" max={duration} step=".1" value={passage.start} onChange={e=>setPassage({...passage,start:Number(e.target.value)})}/></label><label>End (s)<input aria-label="Passage end" type="number" min="0" max={duration} step=".1" value={passage.end} onChange={e=>setPassage({...passage,end:Number(e.target.value)})}/></label><button onClick={()=>setPassage({...view})}>Use visible time range</button><button onClick={()=>setView({...passage})}>Show selected passage</button></div><p className="review-help">Preview includes at least one surrounding five-second chunk where available. Notes crossing the selection stay whole. Very long sustained notes may meet a context edge; dashed notes flag this. A cropped run is not guaranteed to match a full run.</p><button className="primary-action" disabled={busy||working} onClick={()=>setStep(1)}>Continue to experiments</button></>}
      </>}
      {step===1&&session?.source&&<>
        <h3>Find a transcription worth keeping</h3><p>Selected experiment: {passage.start.toFixed(1)}–{passage.end.toFixed(1)}s. Settings below require a new model run.</p>
        <div className="review-controls"><label>Model<select value={settings.model} onChange={e=>setSettings({...settings,model:e.target.value as InferenceSettings["model"]})}><option value="small">Small · start here</option><option value="medium">Medium · more computation</option><option value="large">Large · GPU recommended</option></select></label><button className="primary-action" disabled={busy||working||!validPassage||passage.end-passage.start>60} onClick={()=>void run(false)}>Test selected passage</button><button disabled={busy||working} onClick={()=>void run(true)}>Transcribe full recording</button></div>
        <details><summary>Advanced inference settings</summary><div className="review-controls"><label>Instrument constraint<select value={settings.instruments} onChange={e=>setSettings({...settings,instruments:e.target.value as InferenceSettings["instruments"]})}><option value="piano">Acoustic piano only</option><option value="auto">Detect all instruments</option></select></label><label>Decoding search<select value={settings.beam_size} onChange={e=>setSettings({...settings,beam_size:Number(e.target.value) as 1|2|4})}><option value="1">Greedy · fastest</option><option value="2">2 alternatives · slower</option><option value="4">4 alternatives · slowest</option></select></label></div><p>Instrument constraints forbid other instrument tokens; they do not isolate piano audio. Wider search explores more note sequences, without guaranteeing a better result. Sustained-note continuity stays enabled.</p></details>
        {candidateStale&&<p className="review-warning">Candidate is out of date for these experiment choices. It remains available for comparison; test again to apply changes.</p>}
        <div className="review-version-cards"><div><b>Accepted baseline{corrected?" + manual corrections":""}</b><p>{settingsLabel(baseline)}</p></div><div><b>Candidate · not yet accepted</b><p>{settingsLabel(candidate)}</p></div></div>
        {candidate&&<><p>{candidate.notes.length} reviewable notes{candidate.excluded?` · ${candidate.excluded} drum/out-of-piano-range notes excluded from this piano workflow`:""}. {candidate.full?"Full recording ready for review.":"Passage preview only — a full run is required before import."}</p>{corrected&&<div className="review-warning"><b>Manual correction conflict</b><p>Your edits belong to the current baseline. Keep that branch, or archive it before accepting this candidate. No automatic merge will guess which edits still apply.</p><label><input type="checkbox" checked={archive} onChange={e=>setArchive(e.target.checked)}/> Archive my current correction branch and start from the candidate</label></div>}<div className="review-controls"><button className="primary-action" disabled={busy||(corrected&&!archive)} onClick={()=>void safely(async()=>{await action("accept",{archive_corrections:archive});setArchive(false);setMode("baseline");setAudition("baseline");})}>Accept as baseline</button><button disabled={busy} onClick={()=>void safely(async()=>{await action("discard");setAudition("baseline");})}>Discard candidate</button></div></>}
        {baseline&&<button onClick={()=>{setStep(2);setMode("baseline");setAudition("baseline");}}>Continue to note corrections</button>}
      </>}
      {step===2&&<>
        <h3>Correct the notes, then interpret the rhythm</h3><p>Edits save to a separate correction history. Shift-click or drag a box for multiple notes. Drag notes to move them, drag their right edges to resize, or use the precise fields below. Double-click empty space to add.</p>
        {!baseline?<p>Accept a candidate in step 2 to start editing.</p>:<>
        <div className="review-controls"><button disabled={busy||!session?.edit_cursor} onClick={()=>void safely(async()=>{await action("history/undo");})}><Undo2 size={15}/> Undo</button><button disabled={busy||!session||session.edit_cursor>=session.edits.length-1} onClick={()=>void safely(async()=>{await action("history/redo");})}><Redo2 size={15}/> Redo</button><button disabled={busy} onClick={()=>{const start=Math.min(position,duration-.3);edit([...notes,{id:crypto.randomUUID(),pitch:60,start,end:start+.3,instrument:"acoustic_piano",boundary:false}],"Add middle C");}}>Add note at playhead</button><button disabled={busy||!selected.size} onClick={()=>edit(notes.filter(n=>!selected.has(n.id)),"Delete notes")}>Delete {selected.size||"selected"}</button><button disabled={busy||selected.size<2} onClick={()=>setMerge(true)}>Merge selected…</button></div>
        {merge&&<div className="review-warning"><p>Merge replaces the selected same-pitch notes with one sustain, from the earliest start to the latest end. It removes every repeated attack and fills gaps between them.</p><button onClick={()=>{try{edit(mergeNotes(notes,selected),"Merge attacks into sustain");setMerge(false);}catch(e){setError(String(e));}}}>Replace attacks with one sustain</button><button onClick={()=>setMerge(false)}>Keep separate attacks</button></div>}
        {one&&<NoteFields key={`${one.id}-${one.start}-${one.end}-${one.pitch}`} note={one} disabled={busy} onApply={note=>edit(notes.map(n=>n.id===one.id?note:n),"Edit note values")}/>}
        <details><summary>Saved correction branches ({session?.archives.length||0})</summary>{session?.archives.map((a,i)=><div key={i}><span>{settingsLabel(session.versions[a.baseline])} · {a.edits.length} history entries </span><button disabled={busy} onClick={()=>void safely(async()=>{await action(`restore/${i}`);setSelected(new Set());})}>Restore branch {i+1}</button></div>)}</details>
        <h3>Practice grid</h3><p>Expressive note timing is preserved by default. The detected tempo map follows rubato. Grid changes affect beat/bar interpretation; quantization deliberately changes a separate practice copy.</p>
        <p>{baseline.grid?`Detected ${baseline.grid.bpm.toFixed(1)} BPM average · ${baseline.grid.steady?"steady":"variable tempo"} · ${baseline.grid.beats_per_bar||"unknown"} beats per bar.`:"No usable beat grid detected. Enter a deliberate BPM and meter to prepare structured practice."}</p>
        <details open={!baseline.grid}><summary>Adjust grid and optional quantization</summary><div className="review-controls"><label>Tempo interpretation<select value={practice.bpm!==null?"fixed":"detected"} onChange={e=>setPractice({...practice,bpm:e.target.value==="fixed"?baseline.grid?.bpm||120:null,tempo_map:null})}><option value="detected">Follow detected performance</option><option value="fixed">Use a fixed BPM</option></select></label>{practice.bpm!==null&&<label>Fixed BPM<input type="number" min="20" max="400" value={practice.bpm} onChange={e=>setPractice({...practice,bpm:Number(e.target.value)})}/></label>}<label>Beats per bar<input aria-label="Beats per bar" type="number" min="1" max="12" placeholder={String(baseline.grid?.beats_per_bar||"Set meter")} value={practice.beats_per_bar??""} onChange={e=>setPractice({...practice,beats_per_bar:e.target.value?Number(e.target.value):null})}/></label><label>First downbeat (source s)<input type="number" min="0" step=".01" placeholder={String(baseline.grid?.first_downbeat.toFixed(2)||0)} value={practice.first_downbeat??""} onChange={e=>setPractice({...practice,first_downbeat:e.target.value?Number(e.target.value):null})}/></label><button onClick={()=>setPractice({...practice,first_downbeat:position})}>Set downbeat at playhead</button></div><label><input type="checkbox" checked={practice.quantize} onChange={e=>setPractice({...practice,quantize:e.target.checked})}/> Quantize the practice copy (changes note timing)</label>{practice.quantize&&<div className="review-controls"><label>Steps per beat<select value={practice.subdivision} onChange={e=>setPractice({...practice,subdivision:Number(e.target.value) as PracticeSettings["subdivision"]})}>{[1,2,3,4,6,8].map(n=><option key={n} value={n}>{n}{n===3?" · eighth triplets":n===4?" · sixteenths":""}</option>)}</select></label><label>Move toward grid<input type="range" min="0" max="1" step=".05" value={practice.strength} onChange={e=>setPractice({...practice,strength:Number(e.target.value)})}/>{Math.round(practice.strength*100)}%</label></div>}<p>Apply prepares an export from existing notes; it does not run transcription. Inspect the resulting bars and audition the practice copy before confirmation. The original model timing and your corrections remain stored.</p></details>
        {!baseline.full&&<p className="review-warning">This is a passage experiment. Run and accept a full-recording candidate before preparing the import.</p>}
        <button className="primary-action" disabled={busy||working||!baseline.full} onClick={()=>void safely(async()=>{const s=await saveChoices();await action("prepare",{},s);setStep(3);setConfirmed(false);})}>Apply grid & prepare practice copy</button>
        </>}
      </>}
      {step===3&&<><h3>Review the full piece before importing</h3>{!session?.prepared?<p>Prepare the full-recording baseline in step 3. You can return to corrections while preparation runs.</p>:<>
        <p>{session.prepared.notes.length} notes · full recording · {session.prepared.practice.quantize?"quantized practice copy":"expressive timing preserved"}. Bar alignment adds {session.prepared.source_offset.toFixed(3)}s of leading MIDI time; the review transport compensates for it.</p><p>The roll below shows the actual exported practice notes and bar lines. Compare it with the corrected performance using the audition controls.</p>
        <label className="field"><span>Piece title</span><input maxLength={160} value={title} onChange={e=>setTitle(e.target.value)}/></label><label className="review-confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> I have reviewed the full transcription and the practice bar alignment.</label><button className="primary-action" disabled={busy||!confirmed||dirty||!title.trim()} onClick={()=>void safely(async()=>{transport.current?.pause();const song=await reviewApi<SongDetail>(`/reviews/${session.id}/confirm`,{revision:session.revision,title:title.trim(),reviewed:confirmed});onImported(song);})}>Confirm import & open practice</button>
      </>}</>}
      {session?.source&&<section className="review-inspection">
        <div className="review-transport"><button className="primary-action" disabled={loadingAudio} onClick={()=>void togglePlayback()}>{playing?<Pause size={16}/>:<Play size={16}/>} {loadingAudio?"Loading audio & piano…":playing?"Pause":"Play"}</button><strong>{position.toFixed(2)}s</strong><label><input type="checkbox" checked={loop} onChange={e=>setLoop(e.target.checked)}/> Loop selected passage</label><span className="review-listen">{(["audio","midi","both"] as const).map(v=><button key={v} aria-pressed={listen===v} onClick={()=>setListen(v)}>{v==="both"?"Both":v==="audio"?"Audio only":"MIDI only"}</button>)}</span><label>Audio level<input aria-label="Original audio level" type="range" min="0" max="1" step=".05" value={audioLevel} onChange={e=>setAudioLevel(Number(e.target.value))}/></label><label>MIDI level<input aria-label="Piano MIDI level" type="range" min="0" max="1" step=".05" value={midiLevel} onChange={e=>setMidiLevel(Number(e.target.value))}/></label></div>
        <label className="review-seek">Seek<input aria-label="Seek source audio" type="range" min="0" max={duration} step=".01" value={position} onChange={e=>{const p=Number(e.target.value);setPosition(p);transport.current?.seek(p);}}/></label>
        <div className="review-controls"><span>Auditioning:</span>{(["baseline","candidate","practice"] as const).map(v=><button key={v} disabled={v==="baseline"?!baseline:v==="candidate"?!candidate:!session.prepared} aria-pressed={audition===v} onClick={()=>setAudition(v)}>{v==="baseline"?"Corrected baseline":v==="candidate"?"Candidate":"Practice copy"}</button>)}<span className="review-help">Sampled piano · switches keep the same source position · normal speed</span></div>
        <div className="review-controls"><label>Visible start<input aria-label="Visible start" type="number" min="0" max={duration-.25} step="1" value={view.start} onChange={e=>{const start=Math.max(0,Math.min(duration-.25,Number(e.target.value)));setView({start,end:Math.min(duration,start+view.end-view.start)});}}/></label><label>Visible span<input aria-label="Visible span" type="number" min=".25" max={duration} step="1" value={Number((view.end-view.start).toFixed(2))} onChange={e=>setView({...view,end:Math.min(duration,view.start+Math.max(.25,Number(e.target.value)))})}/></label><button onClick={()=>setView({start:Math.max(0,position-2),end:Math.min(duration,position+18)})}>View around playhead</button><button onClick={()=>setPassage({...view})}>Use visible time range</button>{step!==3&&<label>Show<select aria-label="Comparison display" value={step===2?"baseline":mode} disabled={step===2} onChange={e=>setMode(e.target.value as typeof mode)}><option value="difference">Difference overlay</option><option value="baseline">Baseline alone</option><option value="candidate">Candidate alone</option></select></label>}</div>
        <ReviewPianoRoll before={step===3?session.prepared?.notes||EMPTY:notes} after={candidate?.notes||EMPTY} mode={step===2||step===3||!candidate?"baseline":mode} view={view} position={position} selected={selected} onSelect={setSelected} onEdit={edit} onSeek={p=>{setPosition(p);transport.current?.seek(p);}} editable={step===2&&!!baseline&&!busy} beats={beats}/>
        {step!==2&&step!==3&&!!candidate&&mode==="difference"&&<p className="review-legend"><span style={{color:"#4bd6a0"}}>● Added</span><span style={{color:"#f87c85"}}>□ Removed</span><span style={{color:"#f6c667"}}>● Start/end moved</span><span style={{color:"#64b7ff"}}>● Pitch changed</span><span style={{color:"#c3a0ef"}}>● Ambiguous match</span><span>Outline = baseline; fill = candidate. Ambiguous notes stay unpaired.</span></p>}
        {step===2&&<small>{selected.size} selected · arrows nudge by 50ms / one semitone · Delete removes · Alt-drag resizes · changes save after each gesture</small>}
      </section>}
      </div>
      <footer className="review-footer"><span>{session?`Review saved locally${dirty?" · experiment/grid choices pending":""}`:"Local audio and review history"}</span>{session?.source&&<button disabled={busy||!dirty} onClick={()=>void safely(async()=>{await saveChoices();})}>Save choices</button>}<span>MuScriptor model weights: CC BY-NC 4.0</span></footer>
    </section>
  </div>;
}

function PassageTimeline({duration,passage,onChange}:{duration:number;passage:Passage;onChange:(p:Passage)=>void}) {
  const start=useRef<number|null>(null);
  const at=(e:React.PointerEvent<HTMLDivElement>)=>{const r=e.currentTarget.getBoundingClientRect();return Math.max(0,Math.min(duration,(e.clientX-r.left)/r.width*duration));};
  return <div className="review-timeline" aria-label="Drag to select a passage" onPointerDown={e=>{start.current=at(e);e.currentTarget.setPointerCapture(e.pointerId);}} onPointerUp={e=>{if(start.current!==null){const end=at(e),lo=Math.min(start.current,end),hi=Math.max(start.current,end);if(hi-lo>=.25)onChange({start:Number(lo.toFixed(2)),end:Number(hi.toFixed(2))});start.current=null;}}}><div style={{left:`${passage.start/duration*100}%`,width:`${(passage.end-passage.start)/duration*100}%`}}/><span>{passage.start.toFixed(1)}–{passage.end.toFixed(1)}s selected</span></div>;
}
function NoteFields({note,onApply,disabled}:{note:ReviewNote;onApply:(n:ReviewNote)=>void;disabled:boolean}) {
  const [draft,setDraft]=useState(note);
  return <div className="review-controls"><label>Pitch (MIDI)<input aria-label="Selected note pitch" type="number" min="21" max="108" value={draft.pitch} onChange={e=>setDraft({...draft,pitch:Number(e.target.value)})}/></label><label>Start (s)<input aria-label="Selected note start" type="number" min="0" step=".01" value={draft.start} onChange={e=>setDraft({...draft,start:Number(e.target.value)})}/></label><label>End (s)<input aria-label="Selected note end" type="number" step=".01" value={draft.end} onChange={e=>setDraft({...draft,end:Number(e.target.value)})}/></label><button disabled={disabled||draft.end<=draft.start||draft.start<0||draft.pitch<21||draft.pitch>108} onClick={()=>onApply(draft)}>Apply note edit</button></div>;
}
