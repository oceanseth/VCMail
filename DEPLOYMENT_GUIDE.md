# VCMail NPM Package - Deployment Guide
# This will prompt you for required config vars and then
# creates the mx records, cloudfront distribution, api gateway, and lambda for https://mail.yourdomain.com to provide and serve email

1. clone this repo
2. run npx link in this project
3. run npx link vcmail in project you want to run webmail on
4. run npx vcmail in project you want to have webmail forthe mail backend api)
5. follow promps to enter values/generate vcmail.config file, make sure terraform completes