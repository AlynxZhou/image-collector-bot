Image Collector Bot
===================

An image collector Telegram bot that can download images and texts into an album dir.
-------------------------------------------------------------------------------------

# Usage

Copy `config.example.json` to `config.json` and modify it, then run `node index.js`.

`token` is your Telegram bot token.

`downloadDir` is where you store downloaded images.

`users` is a list of users who is allowed to send messages to this bot.

`buildCommand` is what you want to run after downloaded an album.

`buildCommandWorkDir` is work dir for your build command.
