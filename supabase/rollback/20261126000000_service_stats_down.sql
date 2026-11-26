-- Rollback of 20261126000000_service_stats.sql: removes the public usage-numbers function. Data is not touched.
-- The top page hides the numbers when the function does not exist.
begin;
drop function if exists public.service_stats();
commit;
