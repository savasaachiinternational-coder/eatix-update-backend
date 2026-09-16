import {
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Worker } from 'worker_threads';
import { join } from 'path';
import { Observation } from './face-policy';

@Injectable()
export class FaceEngineService implements OnModuleDestroy {
  private worker?: Worker;
  private ready?: Promise<void>;
  private busy = false;

  async analyze(bytes: Buffer): Promise<Observation> {
    if (this.busy)
      throw new ServiceUnavailableException(
        'Face verification is busy. Please try again.',
      );
    this.busy = true;
    try {
      await this.initialize();
      return await new Promise((resolve, reject) => {
        const worker = this.worker;
        const fail = () => {
          cleanup();
          this.stop();
          reject(
            new ServiceUnavailableException(
              'Face verification is unavailable. Please try again.',
            ),
          );
        };
        const message = (data: any) => {
          if (data.id !== 1) return;
          cleanup();
          if (data.error) reject(new ServiceUnavailableException(data.error));
          else resolve(data.result);
        };
        const timer = setTimeout(fail, 20000);
        const cleanup = () => {
          clearTimeout(timer);
          worker.off('message', message);
          worker.off('error', fail);
          worker.off('exit', fail);
        };
        worker.on('message', message).once('error', fail).once('exit', fail);
        worker.postMessage({ id: 1, bytes });
      });
    } finally {
      this.busy = false;
    }
  }

  private initialize(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const worker = new Worker(join(__dirname, 'face-engine.worker.cjs'));
      this.worker = worker;
      const fail = () => {
        clearTimeout(timer);
        this.stop();
        reject(
          new ServiceUnavailableException(
            'Face verification could not start. Please try again.',
          ),
        );
      };
      const timer = setTimeout(fail, 30000);
      worker.once('error', fail).once('exit', fail);
      worker.once('message', (data) => {
        clearTimeout(timer);
        worker.off('error', fail);
        worker.off('exit', fail);
        if (!data.ready) return fail();
        // Idle crashes must not bring down the API process.
        worker.on('error', () => {
          if (this.worker === worker) this.stop();
        });
        worker.on('exit', () => {
          if (this.worker === worker) this.stop();
        });
        resolve();
      });
    });
    return this.ready;
  }

  private stop() {
    const worker = this.worker;
    this.worker = undefined;
    this.ready = undefined;
    if (worker) void worker.terminate();
  }
  onModuleDestroy() {
    this.stop();
  }
}
