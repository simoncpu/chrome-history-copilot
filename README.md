# AI-Powered Browser History

A Chrome extension that makes your browsing history truly searchable and queryable using AI, while keeping everything private and running locally on your device.

## What it does

This Chrome extension captures and indexes your browser history locally, then lets you search through it using smart AI-powered techniques. You can either search directly or have conversations about your browsing history using Chrome's built-in AI.

## Key Features

- **Smart search** through your history using hybrid retrieval (combines keyword search + semantic similarity)
- **Chat interface** where you can ask questions about your browsing history and get AI-powered answers with links
- **Multiple search modes**: Hybrid+Rerank (default), Hybrid (RRF), Text-only, Vector-only
- **Side panel UI** with two modes:
  1. Search page (default) - search your history with different modes
  2. Chat page - conversational interface powered by Chrome's Prompt API
- **Debug page** for database management and troubleshooting
- **Runs entirely locally** - no data leaves your device

## How it works

The extension uses modern AI techniques to understand the meaning and context of web pages you visit:

- **Captures** your browser history automatically as you browse
- **Indexes** page content using both traditional keyword search and AI embeddings for semantic understanding
- **Stores** everything locally using SQLite with vector storage capabilities
- **Searches** using hybrid retrieval that combines the best of keyword matching and AI similarity
- **Answers** questions about your history using Chrome's on-device AI (Chrome Canary required)

## Privacy

Everything runs completely locally on your device. No browsing data is ever transmitted anywhere. All processing happens in your browser using Chrome's on-device AI capabilities.

## Requirements

- Chrome Canary with on-device AI APIs enabled
- No external dependencies or accounts required

## Installation

1. Load the unpacked extension in Chrome Canary
2. Enable required Chrome AI flags
3. Click the extension icon to open the side panel and start searching your history

Your browsing history becomes a searchable, queryable knowledge base that you can interact with naturally.

## Author

Simon Cornelius P. Umacob <df51if9yh@mozmail.com>