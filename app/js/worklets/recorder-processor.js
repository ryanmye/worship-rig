// Worship Rig recorder tap (SPEC §7, REVIEW 1.8). Runs on the audio thread.
// {numberOfInputs:1, numberOfOutputs:0} on engine.recordTap; posts interleaved stereo Int16 chunks
// (~4096 frames, ArrayBuffer transferred) while recording. Samples are clamped to ±1 (NaN → 0).
// Messages in:  {cmd:'start'} | {cmd:'stop'} | {cmd:'dispose'}
// Messages out: {type:'chunk', buf:ArrayBuffer, frames, peakL, peakR} | {type:'stopped', frames}

class RigRecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.batch = Math.max(128, Math.min(65536, (o.batchFrames | 0) || 4096));
    this.buf = new Int16Array(this.batch * 2);
    this.n = 0;
    this.frames = 0;
    this.peakL = 0;
    this.peakR = 0;
    this.recording = false;
    this.alive = true;
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.cmd === 'start') {
        this.recording = true;
        this.frames = 0;
        this.n = 0;
        this.peakL = 0;
        this.peakR = 0;
      } else if (m.cmd === 'stop') {
        if (this.recording) this.flush(true);
        this.recording = false;
        this.port.postMessage({ type: 'stopped', frames: this.frames });
      } else if (m.cmd === 'dispose') {
        this.recording = false;
        this.alive = false;
      }
    };
  }

  flush(partial) {
    if (this.n === 0) return;
    let out;
    if (partial && this.n < this.batch) {
      out = this.buf.slice(0, this.n * 2);
    } else {
      out = this.buf;
      this.buf = new Int16Array(this.batch * 2);
    }
    this.port.postMessage({ type: 'chunk', buf: out.buffer, frames: this.n, peakL: this.peakL, peakR: this.peakR }, [out.buffer]);
    this.n = 0;
    this.peakL = 0;
    this.peakR = 0;
  }

  process(inputs) {
    if (!this.alive) return false;
    if (!this.recording) return true;
    const input = inputs[0] || [];
    const L = input[0];
    const R = input[1] || input[0];
    const frames = L ? L.length : 128; // disconnected input → record silence, keep time
    for (let i = 0; i < frames; i++) {
      let l = L ? L[i] : 0;
      let r = R ? R[i] : 0;
      if (!(l === l)) l = 0;
      if (!(r === r)) r = 0;
      if (l > 1) l = 1;
      else if (l < -1) l = -1;
      if (r > 1) r = 1;
      else if (r < -1) r = -1;
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      if (al > this.peakL) this.peakL = al;
      if (ar > this.peakR) this.peakR = ar;
      const j = this.n * 2;
      this.buf[j] = Math.round(l < 0 ? l * 32768 : l * 32767);
      this.buf[j + 1] = Math.round(r < 0 ? r * 32768 : r * 32767);
      this.n++;
      if (this.n === this.batch) this.flush(false);
    }
    this.frames += frames;
    return true;
  }
}

registerProcessor('rig-recorder', RigRecorderProcessor);
