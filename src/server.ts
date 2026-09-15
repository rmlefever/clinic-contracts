import { app } from './app.js';
import { config } from './config.js';
import { reminderAndExpirySweep } from './app.js';

// Process entry point: the application (routes, migrations) lives in src/app.ts.
await app.listen({ port: config.port, host: '0.0.0.0' });

// Background sweep (reminders + expiry webhooks). Started here, not in
// app.ts, so test imports of the app never schedule anything.
if (config.remindersEnabled || config.webhookUrl) {
  const run = () => {
    reminderAndExpirySweep().then(
      (r) => { if (r.expired || r.reminded) app.log.info(r, 'background sweep'); },
      (err) => app.log.error({ err }, 'background sweep failed')
    );
  };
  setTimeout(run, 5 * 60_000).unref();  // first run 5 min after boot
  setInterval(run, 60 * 60_000).unref(); // then hourly
}
