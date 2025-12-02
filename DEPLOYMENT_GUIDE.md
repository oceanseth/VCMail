# VCMail NPM Package - Deployment Guide
# This will prompt you for required config vars and then
# creates the mx records, cloudfront distribution, api gateway, and lambda for https://mail.yourdomain.com to provide and serve email

1. clone this repo
2. run `npm link` in this project (creates a global symlink for the vcmail package)
3. run `npm link vcmail` in the project where you want to run webmail on
4. run `npx vcmail` in the project where you want to have webmail (for the mail backend API)
5. follow prompts to enter values/generate vcmail.config file, make sure terraform completes