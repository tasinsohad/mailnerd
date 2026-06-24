-- Fix job_templates to use JSON text instead of PostgreSQL arrays
ALTER TABLE job_templates 
  ALTER COLUMN subdomain_prefixes TYPE text,
  ALTER COLUMN person_names TYPE text;

-- Update existing data if any to be valid JSON
UPDATE job_templates 
  SET subdomain_prefixes = '[]', 
      person_names = '[]' 
  WHERE subdomain_prefixes IS NULL OR person_names IS NULL;

-- Make columns not nullable with default
ALTER TABLE job_templates 
  ALTER COLUMN subdomain_prefixes SET DEFAULT '[]',
  ALTER COLUMN person_names SET DEFAULT '[]';