-- Item upload prices: up to 10 items = 10 credits, more than 10 = 25 (the engine picks the code).
update public.credit_prices set label = 'Item list upload with up to 10 items' where action_code = 'bulk_import_small';
update public.credit_prices set label = 'Item list upload with more than 10 items' where action_code = 'bulk_import';
