import { auditionEvents, transportPosition, type Passage, type ReviewNote } from "./youtubeReview";

/** Original audio and sampled piano share a single AudioContext clock. No media-element drift. */
export class ReviewTransport {
  private context: AudioContext | null = null;
  private audio: AudioBuffer | null = null;
  private samples: { pitch: number; buffer: AudioBuffer }[] = [];
  private voices = new Set<AudioBufferSourceNode>();
  private audioGain: GainNode | null = null;
  private midiGain: GainNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private anchor = 0;
  private origin = 0;
  private scheduled = 0;
  private notes: ReviewNote[] = [];
  private loop: Passage | null = null;
  private loading: Promise<void> | null = null;
  private disposed = false;
  playing = false;
  duration = 0;
  onPosition: (position: number, playing: boolean) => void = () => {};
  async load(url: string) {
    if (this.loading) return this.loading;
    this.loading = this.initialize(url).catch(error => { this.loading = null; throw error; });
    return this.loading;
  }
  private async initialize(url: string) {
    if (this.disposed) return;
    if (!this.context) this.context = new AudioContext();
    const ctx = this.context;
    const decode = async (url: string) => { const response = await fetch(url); if (!response.ok) throw new Error("Could not load audio or piano samples. Check your connection and retry."); return ctx.decodeAudioData(await response.arrayBuffer()); };
    const [audio, samples] = await Promise.all([
      decode(url),
      Promise.all([[21,"A0"],[36,"C2"],[48,"C3"],[60,"C4"],[72,"C5"],[84,"C6"],[96,"C7"],[108,"C8"]].map(async ([pitch, name]) => ({ pitch: Number(pitch), buffer: await decode(`https://tonejs.github.io/audio/salamander/${name}.mp3`) }))),
    ]);
    if (this.disposed) return;
    this.audio = audio; this.samples = samples; this.duration = audio.duration;
    this.audioGain = ctx.createGain(); this.audioGain.connect(ctx.destination);
    this.midiGain = ctx.createGain(); this.midiGain.connect(ctx.destination);
  }
  get position() { return this.playing && this.context ? transportPosition(this.origin, this.context.currentTime-this.anchor, this.loop, this.duration) : this.origin; }
  levels(audio: number, midi: number) { if (this.audioGain) this.audioGain.gain.value = audio; if (this.midiGain) this.midiGain.gain.value = midi * .65; }
  configure(notes: ReviewNote[], loop: Passage | null) {
    const position = this.position, wasPlaying = this.playing;
    this.stop(); this.notes = notes; this.loop = loop; this.origin = position;
    if (wasPlaying) this.start(position);
  }
  async play() { if (!this.context || !this.audio) throw new Error("Load comparison audio first."); await this.context.resume(); this.start(this.origin); }
  pause() { const p = this.position; this.stop(); this.origin = p; this.onPosition(p, false); }
  seek(position: number) { const wasPlaying = this.playing; this.stop(); this.origin = Math.min(this.audio ? this.duration : Infinity, Math.max(0,position)); if (wasPlaying) this.start(this.origin); else this.onPosition(this.origin,false); }
  private stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.playing = false; for (const v of this.voices) { try { v.stop(); } catch {} } this.voices.clear(); }
  private start(position: number) {
    if (this.disposed || !this.context || !this.audio) return;
    this.stop();
    if (this.loop && (position < this.loop.start || position >= this.loop.end)) position = this.loop.start;
    else if (position >= this.duration) position = 0;
    this.origin = position; this.anchor = this.context.currentTime + .025; this.scheduled = 0; this.playing = true;
    const source = this.context.createBufferSource(); source.buffer = this.audio; source.connect(this.audioGain!);
    if (this.loop) { source.loop = true; source.loopStart = this.loop.start; source.loopEnd = this.loop.end; }
    this.track(source); source.start(this.anchor, position);
    this.tick(); this.timer = setInterval(() => this.tick(), 25);
  }
  private track(source: AudioBufferSourceNode) { this.voices.add(source); source.onended = () => { this.voices.delete(source); source.disconnect(); }; }
  private tick() {
    const ctx = this.context!;
    const elapsed = ctx.currentTime - this.anchor;
    // Recover coherently after a background-tab timer stall; never replay a backlog.
    if (elapsed - this.scheduled > .15) { this.start(this.position); return; }
    const until = Math.max(0, elapsed) + .15;
    for (const n of auditionEvents(this.notes,this.origin,this.scheduled,until,this.loop,this.duration)) {
      const sample = this.samples.reduce((a,b) => Math.abs(a.pitch-n.pitch) < Math.abs(b.pitch-n.pitch) ? a : b);
      const source = ctx.createBufferSource(), gain = ctx.createGain();
      source.buffer = sample.buffer; source.playbackRate.value = 2 ** ((n.pitch-sample.pitch)/12);
      source.connect(gain); gain.connect(this.midiGain!);
      const at = this.anchor+n.at, end = at+n.duration;
      gain.gain.setValueAtTime(.8,at); gain.gain.setValueAtTime(.8,Math.max(at,end-.015)); gain.gain.linearRampToValueAtTime(0,end);
      this.track(source); source.onended = () => { this.voices.delete(source); source.disconnect(); gain.disconnect(); };
      source.start(at); source.stop(end);
    }
    this.scheduled = until;
    if (!this.loop && elapsed + this.origin >= this.duration) { this.origin = this.duration; this.stop(); }
    this.onPosition(this.position,this.playing);
  }
  dispose() { this.disposed = true; this.stop(); void this.context?.close(); }
}
