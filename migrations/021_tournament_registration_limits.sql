-- Match registration capacity to the revised tournament formats.
UPDATE sports SET max_teams = 24 WHERE name = 'Futsal';
UPDATE sports SET max_teams = 16 WHERE name IN ('Cricksal', 'Crickshal');
