import { eventSchema } from '@runtipi/shared';
import { Worker } from 'bullmq';
import { AppExecutors, RepoExecutors } from '@/services';
import { logger } from '@/lib/logger';
import { getEnv } from '@/lib/environment';

const {
  installApp,
  resetApp,
  startApp,
  stopApp,
  restartApp,
  uninstallApp,
  updateApp,
  regenerateAppEnv,
} = new AppExecutors();
const { cloneRepo, pullRepo } = new RepoExecutors();

const runCommand = async (jobData: unknown) => {
  const event = eventSchema.safeParse(jobData);

  if (!event.success) {
    throw new Error('Event is not valid');
  }

  const { data } = event;

  let success = false;
  let message = `Event has invalid type or args ${JSON.stringify(data)}`;

  if (data.type === 'app') {
    if (data.command === 'install') {
      ({ success, message } = await installApp(data.appid, data.form));
    }

    if (data.command === 'stop') {
      ({ success, message } = await stopApp(data.appid, data.form, data.skipEnv));
    }

    if (data.command === 'start') {
      ({ success, message } = await startApp(data.appid, data.form, data.skipEnv));
    }

    if (data.command === 'uninstall') {
      ({ success, message } = await uninstallApp(data.appid, data.form));
    }

    if (data.command === 'update') {
      ({ success, message } = await updateApp(data.appid, data.form));
    }

    if (data.command === 'reset') {
      ({ success, message } = await resetApp(data.appid, data.form));
    }

    if (data.command === 'restart') {
      ({ success, message } = await restartApp(data.appid, data.form));
    }

    if (data.command === 'generate_env') {
      ({ success, message } = await regenerateAppEnv(data.appid, data.form));
    }
  } else if (data.type === 'repo') {
    if (data.command === 'clone') {
      ({ success, message } = await cloneRepo(data.url));
    }

    if (data.command === 'update' && process.env.NODE_ENV !== 'development') {
      ({ success, message } = await pullRepo(data.url));
    }
  }

  return { success, message };
};

/**
 * Start the worker for the events queue
 */
export const startWorker = async () => {
  const repeatWorker = new Worker(
    'repeat',
    async (job) => {
      const { message, success } = await runCommand(job.data);
      if (!job.id?.startsWith('repeat:')) {
        logger.info(`Processing job ${job.id} with data ${JSON.stringify(job.data)}`);
      }

      return { success, stdout: message };
    },
    {
      connection: {
        host: getEnv().redisHost,
        port: 6379,
        password: getEnv().redisPassword,
        connectTimeout: 60000,
      },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 500 },
      concurrency: 3,
    },
  );

  const worker = new Worker(
    'events',
    async (job) => {
      logger.info(`Processing job ${job.id} with data ${JSON.stringify(job.data)}`);
      const { message, success } = await runCommand(job.data);

      return { success, stdout: message };
    },
    {
      connection: {
        host: getEnv().redisHost,
        port: 6379,
        password: getEnv().redisPassword,
        connectTimeout: 60000,
      },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 500 },
      concurrency: 1,
    },
  );

  worker.on('ready', () => {
    logger.info('Worker is ready');
  });

  worker.on('completed', (job) => {
    logger.info(`Job ${job.id} completed with result:`, JSON.stringify(job.returnvalue));
  });

  repeatWorker.on('completed', (job) => {
    if (!job.id?.startsWith('repeat:')) {
      logger.info(`Job ${job.id} completed with result:`, JSON.stringify(job.returnvalue));
    }
  });

  worker.on('failed', (job) => {
    logger.error(`Job ${job?.id} failed with reason ${job?.failedReason}`);
  });

  worker.on('error', async (e) => {
    logger.debug(`Worker error: ${e}`);
  });
};
