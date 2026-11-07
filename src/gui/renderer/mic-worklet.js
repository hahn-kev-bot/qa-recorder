// Runs on the audio thread: hands the main thread 100 ms blocks of mono samples at the context's rate (16 kHz).
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(1600);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.block[this.filled++] = channel[i];
        if (this.filled === this.block.length) {
          this.port.postMessage(this.block.slice());
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
