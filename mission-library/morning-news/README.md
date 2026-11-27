# morning-news

Sends you a short summary of the news on the topics you follow.

- It runs every day at 08:00, and when you write to it in the chat.
- It uses the web search and the web page reader. Both only read.
- It needs no secret.

## Use it

```
mission-agent library add morning-news --root ~/agents/ada
```

Or ask the mission admin in the chat to add `morning-news` from the library.

Then tell it your topics in the chat, for example: `/mission morning-news` and "I follow chip makers and Italian politics".

To change the time, edit `at` in the copied `manifest.yaml`. It is a cron expression with five fields.
