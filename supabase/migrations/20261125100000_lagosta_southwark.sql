-- From the call agent's second check
update establishments set legal_name = coalesce(legal_name, name), name = 'A Lagosta' where name = 'Lage & Lage' and address ilike '901 E Cayuga%';
-- one call covers both restaurants; the main address is Southwark's
update establishments set address = '701 S 4th St', addr_key = '701-s-4th' where name = 'Southwark & Ambra' and address like '701 & 705 S 4th St%';
