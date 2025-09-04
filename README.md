# 🚀 VCMail

> **Open Source Email Server providing webmail with on-device LLM and end-to-end encryption so no identity/email provider can see your email or train on it's data.**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[![Firebase](https://img.shields.io/badge/Firebase-Realtime%20Database-orange.svg)](https://firebase.google.com/) for storing and sending realtime emails, notifications, etc.

[![AWS](https://img.shields.io/badge/AWS-Lambda%20%7C%20S3-yellow.svg)](https://aws.amazon.com/) for long term storage and soc compliance to store the encrypted contents in a form retrievable in the future by sender/recipient private key holders.

[![WebLLM](https://img.shields.io/badge/AI-LLM%20Integration-purple.svg)](https://webllm.mlc.ai/) On-device llm, you can provide and train your own model if you wish, it runs in your browser, since you are the only one decrypting emails.

[![Oracle](https://img.shields.io/badge/Oracle%20Cloud-F80000?style=flat&logo=Oracle&logoColor=white)](https://signup.cloud.oracle.com/) - for a FREE imap/smtp server that handles the requirements of most small companies. Not required, can function soley with webmail client.

VCMail was created while working on Voice Cert technologies, the VC stands for that. But it may also be a great way to communicate over email to Venture Capitalists when starting new companies, showing your expertise along with being security-conscious.

Emails will include the voicecert image to verify identity and allow a link to decrypt the email, such that **NO mail provider snooping or man in the middle is possible**.

> ⚠️ **Security Warning**: No other email servers are safe to put passwords in because emails are not inherently secure and can be intercepted, hacked, or sent to the wrong person. Company ideas and secrets you might put in email are vulnerable - Google and other companies have AI training on your email data!

VCMail provides both security and **data sovereignty** - only your own infra will be able to train on your email data. And since the receiving party has to go through an external link and decryption step, even sending emails to Gmail will not allow Google to train on your emails, nor governments to spy on it. Only the recipient with approved identity providers will be able to read the contents. And if multiple providers are used, no single provider will be able to read the contents. This means even google cannot know the contents of the email despite sending over gmail! 

---

## ✨ Key Features

| Feature | Description |
|---------|-------------|
| 🆓 **Free Email** | Setting up email for your company should be simple and free. Press a button, and you have a free email server, scaling up to hundreds of users and thousands of emails a day. |
| ☁️ **AWS IAC Setup** | Received emails are routed to a Lambda function, which saves them to S3 and a decoded version on Firebase along with metadata and lookup data for LLM to get context on emails sent from the same contact, terms used within the email unique to a set of specific conversations, and more. |
| 🤖 **AI Integration** | AI can quickly 'deep think' to find all related context on any subject you are discussing while you're typing it, based on your previous activity. |
| 🔗 **MCP Server Linking** | Linking MCP servers and contacts from other apps, having the ability to sync conversations from the contact you're constructing an email to from other services, like WhatsApp. |

---

## 🎯 Example Use Case

You just started a company, bought a domain, and want to be able to email from a new email on your domain:

1. **Clone this repo**
2. **Run `webmail-install`**
3. **Instantly have a `yourdomain.com/email` webmail URL** you can use
4. **Configure internally** for other company members to use

**Within 10 minutes**, your company is able to send and receive email using the webmail client.

Want more advanced features? Create a free tier Oracle server and run the `server-install` for that. Now your employees can integrate Outlook.

### 🤖 AI-Powered Context Awareness

**Yesterday**: You sent Steve a message on WhatsApp discussing how your company handles X.

**Today**: Jill is asking about how to handle X.

**AI Magic**: The AI automatically:
- Gets metadata on X to know you had a conversation with Steve about it by using [![WhatsApp MCP](https://img.shields.io/badge/WhatsApp-MCP%20Server-green.svg?logo=whatsapp)](https://github.com/lharries/whatsapp-mcp)
- Knows if you've ever sent an email to Jill and Steve
- Determines if you've had a conversation on WhatsApp including both Jill and Steve
- Advises on the email response to Jill about:
  - How your company handles X
  - Whether she should be told that Steve also knows this
  - The date of your conversation with Steve
  - Whether Jill and Steve work at the same company or your company
  - If this is internal communication
  - Allows 'share with internal' tagged emails to be linked to/seen by Jill when she's at the same company as you.

---

## 🚀 Quick Start

### Prerequisites
- AWS Account
- Firebase Project
- Domain Name

### Installation

1. **Set up Firebase Realtime Database And Service Account**   
   ## Create a new firebase project for [yourdomain]email
   ## Then - in your [![AWS application parameters]](https://console.aws.amazon.com/systems-manager/parameters), create:
   /voicecert/prod/firebase_service_account
   

2. **Clone the Repository**
   ```bash
   git clone https://github.com/yourusername/VCMail.git
   cd VCMail
   ```

3. **Install Webmail**
   ```bash
   ./webmail-install
   ```

4. **Access Your Email**
   - Navigate to `yourdomain.com/email`
   - Start sending and receiving emails!

### Advanced Setup

For Outlook integration and enterprise features:

```bash
# Create Oracle server (free tier)
./server-install
```

---

## 🏗️ Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Email Server  │───▶│   AWS Lambda    │───▶│   Firebase DB   │
│                 │    │                 │    │                 │
│  (webmail/     │    │  (processes &   │    │  (stores email  │
│   outlook)      │    │   saves to S3)  │    │   metadata)     │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                                │
                                ▼
                       ┌─────────────────┐
                       │      S3         │
                       │                 │
                       │  (raw emails)   │
                       └─────────────────┘
```

---

## 🔐 Security Features

- **End-to-end encryption** for sensitive communications
- **VoiceCert identity verification** with cryptographic signatures
- **Data sovereignty** - your data stays on your infrastructure
- **No third-party AI training** on your email content
- **Government-proof** communication channels

---

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guidelines](CONTRIBUTING.md) for details.

### Development Setup
```bash
# Fork the repository
# Create a feature branch
git checkout -b feature/amazing-feature

# Make your changes
# Commit with a descriptive message
git commit -m "Add amazing feature"

# Push to your fork
git push origin feature/amazing-feature

# Open a Pull Request
```

---

## 📄 License

This project is licensed under the Apache 2.0 License - see the [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- Built with ❤️ for the open source community
- Special thanks to Voice Cert technologies
- Inspired by the need for secure, private email communication

---

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/yourusername/VCMail/issues)
- **Discussions**: [GitHub Discussions](https://github.com/yourusername/VCMail/discussions)
- **Wiki**: [Project Wiki](https://github.com/yourusername/VCMail/wiki)

---

<div align="center">

**Made with ❤️ for secure email communication**

[![Star](https://img.shields.io/github/stars/yourusername/VCMail?style=social)](https://github.com/yourusername/VCMail)
[![Fork](https://img.shields.io/github/forks/yourusername/VCMail?style=social)](https://github.com/yourusername/VCMail)

</div>
