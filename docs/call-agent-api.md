# Call agent API

The phone agent talks to Supabase over HTTPS. Two calls, both `POST`, both JSON.

**Base URL:** `https://drgmcdgejkqihmjlbcdq.supabase.co/rest/v1/rpc/`
**Headers on every request:**
- `apikey: <Supabase publishable (anon) key>` (Supabase: Project Settings > API Keys)
- `Content-Type: application/json`

**Token:** every body includes `"token"`. Get it in Supabase's SQL Editor:
`select value from private.settings where key = 'call_agent_token';`
To replace it: `update private.settings set value = encode(gen_random_bytes(24), 'hex') where key = 'call_agent_token';`

## 1. Who to call next: `next_calls`

```json
{ "token": "...", "how_many": 10 }
```
Returns a list: `establishment_id`, `bar_name`, `address`, `neighborhood`, `phone`, `call_type` (`new` or `verify`),
`listed_info` (what the site lists now, for verify calls). Never-called bars come first.

Who's in the queue: bars, restaurants, hotel bars, breweries, distilleries and winery tasting rooms with a phone
number. Grocery chains, markets, delis, bottle shops, convenience stores and gas stations are left out, and "beer only"
licenses count only when the name looks like a bar or restaurant. Override one place in Supabase with
`update establishments set call_eligible = false where name = '...';` (true = always call, empty = automatic).

Nothing calls on its own: the agent only gets bars when someone asks it for the next batch. A bar rests for 180 days
only after a complete call: it confirmed what we list, gave days, times and deals that went live, or clearly said it
has no happy hour. Anything less (voicemail, no answer, unclear, low confidence, missing deals, rejected in review)
can be retried after 2 days. `record_call` returns `"complete": true/false`. Bars that
asked not to be called never come back. Change the timing in Supabase's SQL editor:
`update private.settings set value = '365' where key = 'recall_after_days';` (or `retry_after_days`).

## 2. Report a call: `record_call`

```json
{ "token": "...", "result": {
  "establishment_id": "from next_calls",
  "call_type": "new | verify",
  "outcome": "completed | voicemail | no_answer | busy_call_back | refused | wrong_number | permanently_closed",
  "has_happy_hour": "yes | no | unknown",
  "schedule": [ { "days": ["Mon","Tue","Wed","Thu","Fri"], "start": "16:00", "end": "19:00" } ],
  "deals": [ { "item": "draft beers", "price": "$5", "notes": "" } ],
  "where": "bar only | whole venue | unknown",
  "specials_change_frequency": "never | seasonal | monthly | weekly | daily | varies | unknown",
  "specials_change_notes": "",
  "listed_info_correct": "yes | no | partly | n/a",
  "other_specials": "",
  "spoke_with": "first name, role",
  "callback_time": "",
  "do_not_call": false,
  "confidence": "high | medium | low",
  "notes": "",
  "call_time": "2026-11-25T15:20:00-05:00",
  "transcript_url": ""
} }
```
Times are 24-hour. If `establishment_id` is missing, the call is matched by `phone`.

Returns `{"ok": true, "action": "...", "review": "..."}`:

| action | meaning |
|---|---|
| `published` | New happy hour, high confidence, within PA rules, nothing else on file: live at the next site build |
| `verified` | Bar confirmed what we list: verified date refreshed |
| `needs_review` | Held for the weekly review (reason in `review`): low confidence, breaks a PA rule, or differs from the bar's website |
| `no_happy_hour` | Bar has no happy hour |
| `saved` | Stored only (voicemail, no answer, refused...). `review` is set when a person should look (e.g. reported closed) |

Every call is stored untouched in the `calls` table either way.
