-- Undo the one-off: the database makes no outgoing web requests.
drop extension if exists pg_net;
