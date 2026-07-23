# ADR 0005 — Server-persistent scheduler

**Status:** Accepted

Laravel Scheduler with a normal cron job and PostgreSQL processes deadlines, reminders, expired flags, daily rollover, and server events while browsers are closed. Add Redis only after a documented scale or latency need.
