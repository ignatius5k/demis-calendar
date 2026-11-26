select cron.schedule(
  'demi-check-openings',
  '*/5 * * * *',
  $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'demi_endpoint'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Demi-Cron', (select decrypted_secret from vault.decrypted_secrets where name = 'demi_cron_key')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 45000
    )
    where exists (select 1 from demi.settings where connection is not null);
  $job$
);
