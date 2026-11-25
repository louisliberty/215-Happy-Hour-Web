-- Incomplete calls (voicemail, no answer, unclear answer, times but no deals) are retried after 2 days.
-- Only replaces the old default of 7, so a value set by hand later is kept.
update private.settings set value = '2' where key = 'retry_after_days' and value = '7';
