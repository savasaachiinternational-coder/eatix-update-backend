// Runs recognition off the API event loop. No images or embeddings are logged.
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const tf = require('@tensorflow/tfjs');
const sharp = require('sharp');
const humanDir = path.dirname(require.resolve('@vladmandic/human'));
const modelDir = path.resolve(humanDir, '../models');

tf.io.registerLoadRouter((url) => {
  if (typeof url !== 'string' || !url.startsWith('file://')) return null;
  const file = fileURLToPath(url);
  if (path.dirname(file) !== modelDir)
    throw new Error('Invalid model location');
  return {
    load: async () => {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      const weightSpecs = [];
      const buffers = [];
      for (const group of json.weightsManifest) {
        weightSpecs.push(...group.weights);
        for (const name of group.paths) {
          const weightFile = path.resolve(modelDir, name);
          if (path.dirname(weightFile) !== modelDir)
            throw new Error('Invalid weights');
          buffers.push(fs.readFileSync(weightFile));
        }
      }
      const data = Buffer.concat(buffers);
      return {
        modelTopology: json.modelTopology,
        signature: json.signature,
        weightSpecs,
        weightData: data.buffer.slice(
          data.byteOffset,
          data.byteOffset + data.byteLength,
        ),
      };
    },
  };
});

const { Human } = require(path.join(humanDir, 'human.node-wasm.js'));
const human = new Human({
  backend: 'wasm',
  wasmPath:
    path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm')) + '/',
  modelBasePath: pathToFileURL(modelDir).href + '/',
  debug: false,
  async: false,
  cacheSensitivity: 0,
  skipAllowed: false,
  filter: { enabled: false },
  gesture: { enabled: false },
  face: {
    enabled: true,
    detector: { rotation: true, maxDetected: 2, minConfidence: 0.8 },
    mesh: { enabled: true },
    description: { enabled: true, skipFrames: 0, skipTime: 0 },
    antispoof: { enabled: true, skipFrames: 0, skipTime: 0 },
    liveness: { enabled: true, skipFrames: 0, skipTime: 0 },
    iris: { enabled: false },
    emotion: { enabled: false },
  },
  body: { enabled: false },
  hand: { enabled: false },
  object: { enabled: false },
  segmentation: { enabled: false },
});

async function analyze(bytes) {
  const { data, info } = await sharp(Buffer.from(bytes), {
    limitInputPixels: 16000000,
  })
    .rotate()
    // BlazeFace resizes its tensor to a square. Letterbox here so portrait
    // camera frames preserve face proportions instead of being stretched.
    .resize(640, 640, { fit: 'contain', background: '#000000' })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const input = tf.tensor4d(data, [1, info.height, info.width, 3], 'float32');
  try {
    const result = await human.detect(input);
    if (result.error) throw new Error('Recognition failed');
    if (result.face.length !== 1) return { count: result.face.length };
    const face = result.face[0];
    return {
      count: 1,
      embedding: face.embedding,
      score: Math.min(face.boxScore, face.faceScore),
      real: face.real,
      live: face.live,
      yaw: face.rotation?.angle.yaw,
      pitch: face.rotation?.angle.pitch,
      size: Math.min(face.box[2], face.box[3]),
    };
  } finally {
    input.dispose();
  }
}

human
  .load()
  .then(async () => {
    // Validate the runtime before accepting camera frames.
    const input = tf.zeros([1, 256, 256, 3]);
    try {
      await human.detect(input);
    } finally {
      input.dispose();
    }
    parentPort.postMessage({ ready: true });
    parentPort.on('message', async ({ id, bytes }) => {
      try {
        parentPort.postMessage({ id, result: await analyze(bytes) });
      } catch {
        parentPort.postMessage({
          id,
          error: 'Could not read the camera image. Please try again.',
        });
      }
    });
  })
  .catch(() => {
    throw new Error('Face recognition models could not load');
  });
