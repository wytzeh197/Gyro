#!/usr/bin/env node

// usegyro.io is the gyro-website Cloudflare worker. Deploying this app
// checkout uploads the old site and replaces that worker. That is what put
// the previous website back on 13 October 2026.

console.error(`Refusing to deploy usegyro.io from the Gyro app checkout.

This command used to build site/ and upload it to the Cloudflare worker
named "usegyro". The public site is published from the private
gyro-website repository. A deploy from here replaces the whole site,
including pages that this checkout no longer owns.

Publish website and catalog changes from gyro-website:

  cd /Users/wytze/gyro-website
  npm run catalog:sync -- /path/to/Gyro
  npm run site:check
  npm run site:deploy

site/wrangler.toml in this checkout no longer names the production worker.
Do not point wrangler at "usegyro" from here.`);
process.exit(1);
