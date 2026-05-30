# Contributing to Lunel

Thank you for your interest in contributing to Lunel! This guide will help you get your development environment set up.

## 🛠️ Prerequisites

Before you begin, ensure you have the following installed on your system:

- **Node.js** (v18 or higher)
- **Bun** (Required for Manager and Proxy)
  - Install: `curl -fsSL https://bun.sh/install | bash`
- **Rust & Cargo** (Required for PTY)
  - Install: [rustup.rs](https://rustup.rs/)
- **Go** (Required for Sandman - *Experimental*)
- **Make** (Usually pre-installed on macOS/Linux)

## 🚀 Quick Start

1. **Fork and Clone** the repository.
2. **Install all dependencies** using the top-level Makefile:
   ```bash
   make install
   ```
## 🔐 Environment Variables

The project requires some environment variables to be set for the Proxy and Manager. 

1. Create a `.env` file in the `proxy/` and `manager/` directories (if they don't exist).
2. Ensure `MANAGER_URL` is defined in `proxy/.env`:
   ```text
   MANAGER_URL=http://localhost:3000
   ```
