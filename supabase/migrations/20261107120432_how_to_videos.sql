-- How-to videos: the onboarding clip plays on the welcome card; chapters are YouTube links.
-- Change a link with: update platform_settings set value = jsonb_set(value, '{chapters,10}', '"https://youtu.be/…"') where key = 'how_to_videos';
insert into public.platform_settings (key, value, note) values
  ('how_to_videos', jsonb_build_object(
     'onboarding', 'https://app.autocraft-solutions.com/media/how-to-start.mp4',
     'ad', 'https://youtu.be/K5kkpRnOj-w',
     'chapters', jsonb_build_object(
        '0', null, '1', null,
        '2', 'https://youtu.be/AUPg5XQzNF8',
        '3', 'https://youtu.be/ST6g7X8jRmA',
        '4', 'https://youtu.be/x8C8XP0jvaI',
        '5', 'https://youtu.be/702R-ZW0cf0',
        '6', 'https://youtu.be/BP9aeg2uR00',
        '7', 'https://youtu.be/E2tunJHNNNo',
        '8', 'https://youtu.be/RuSfDWINA8o',
        '9', 'https://youtu.be/fuB1S81dcvg',
        '10', 'https://youtu.be/1jkTJfK4d_c'),
     'full', null),
   'How-to videos: onboarding = video on the welcome card (served by the dashboard site); chapters/full = YouTube links. null = not uploaded yet.')
on conflict (key) do nothing;
