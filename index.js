(async () => {
  const fs = require("fs/promises");
  const path = require("path");
  const {exec} = require("child_process");
  const {
    BotMaster,
    BotServant,
    BotAPI,
    BotLogger,
    botUtils
  } = require("aztgbot");
  const config = require("./config.json");
  const botAPI = new BotAPI(config["token"]);
  const botLogger = new BotLogger({"debug": false});
  const {downloadDir} = config;

  const State = {
    "IDLE": 0,
    "CREATE": 1,
    "DELETE": 2,
    "TEXT": 3,
    "IMAGES": 4,
    "AUTHORS": 5,
    "TAGS": 6,
    "DATE": 7
  };

  const UserState = {
    "ALLOWED": 0,
    "NOT_ALLOWED": 1,
    "NO_USER_NAME": 2,
    "NO_USERS": 3
  };

  const myCommands = [
    {"command": "create", "description": "Begin post creating operation."},
    {"command": "delete", "description": "Begin post deleting operation."},
    {"command": "text", "description": "Add a text section for post."},
    {"command": "images", "description": "Add an images section for post."},
    {"command": "authors", "description": "Add an authors section for post."},
    {"command": "tags", "description": "Add a tags section for post."},
    {"command": "date", "description": "Set created date and time."},
    {"command": "commit", "description": "End and submit operation."},
    {"command": "cancel", "description": "End and discard operation."}
  ];

  // Only one committing task is allowed at the same time.
  let committing = false;

  class ImageCollectorBot extends BotServant {
    // timeout: how many seconds to wait before automatically cancel uncommitted
    // operation. By default a servant will be destoryed after 5 min, so don't be
    // too long.
    constructor(botAPI, identifier, botID, botName, timeout = 3 * 60) {
      super(botAPI, identifier, botID, botName);
      this.timeout = timeout;
      this.commandHandlers = {
        "create": this.onCreateCommand.bind(this),
        "delete": this.onDeleteCommand.bind(this),
        "text": this.onTextCommand.bind(this),
        "images": this.onImagesCommand.bind(this),
        "authors": this.onAuthorsCommand.bind(this),
        "tags": this.onTagsCommand.bind(this),
        "date": this.onDateCommand.bind(this),
        "commit": this.onCommitCommand.bind(this),
        "cancel": this.onCancelCommand.bind(this)
      };
      this.state = State.IDLE;
      this.post = null;
      this.deletedPosts = null;
      this.timeoutID = null;
    }

    // override
    async processUpdate(update) {
      // This bot only handle private chating.
      if (update["message"] == null ||
        update["message"]["chat"]["type"] !== "private") {
        return;
      }
      switch (this.checkUser(update)) {
      case UserState.NOT_ALLOWED:
        await this.botAPI.sendChatAction(
          update["message"]["chat"]["id"], "typing"
        );
        await this.botAPI.sendMessage(
          update["message"]["chat"]["id"],
          "Your user name is not in allowed users list so you are not allowed to publish images.",
          {"replyToMessageID": update["message"]["message_id"]}
        );
        return;
      case UserState.NO_USER_NAME:
        await this.botAPI.sendChatAction(
          update["message"]["chat"]["id"], "typing"
        );
        await this.botAPI.sendMessage(
          update["message"]["chat"]["id"],
          "You don't have a username so you are not allowed to publish images.",
          {"replyToMessageID": update["message"]["message_id"]}
        );
        return;
      case UserState.NO_USERS:
        await this.botAPI.sendChatAction(
          update["message"]["chat"]["id"], "typing"
        );
        await this.botAPI.sendMessage(
          update["message"]["chat"]["id"],
          "Allowed users list is empty so no one is allowed to publish images, please add an array of Telegram user names as `users` key in `config.json`\\.",
          {
            "replyToMessageID": update["message"]["message_id"],
            "parseMode": "MarkdownV2"
          }
        );
        return;
      default:
        break;
      }
      if (update["message"]["text"] != null) {
        this.processText(update);
      }
      // Also process photo caption.
      if (update["message"]["caption"] != null) {
        // Should be safe.
        update["message"]["text"] = update["message"]["caption"];
        this.processText(update);
      }
      if (update["message"]["photo"] != null) {
        this.processImages(update);
      }
      // TODO: uncompressed images maybe sent as files.
      botLogger.debug(`${this.botName}@${this.identifier}: state: ${this.state}, post: ${JSON.stringify(this.post, null, "  ")}, deletedPosts: ${JSON.stringify(this.deletedPosts, null, "  ")}`);
    }

    isMyCommand(update, command) {
      return update["message"]["text"].startsWith(`/${command}`) ||
        update["message"]["text"].startsWith(`/${command}@${this.botName}`);
    }

    reset() {
      this.state = State.IDLE;
      this.post = null;
      this.deletedPosts = null;
    }

    refreshTimer() {
      if (this.timeoutID != null) {
        clearTimeout(this.timeoutID);
      }
      this.timeoutID = setTimeout(async () => {
        this.timeoutID = null;
        if (this.checkState(State.IDLE)) {
          return;
        }
        this.reset();
        // identifier is chat ID.
        await this.botAPI.sendChatAction(this.identifier, "typing");
        await this.botAPI.sendMessage(
          this.identifier,
          "Your operations have been cancelled because of timeout."
        );
      }, this.timeout * 1000);
    }

    checkState(...validStates) {
      for (const state of validStates) {
        if (this.state === state) {
          return true;
        }
      }
      return false;
    }

    checkUser(update) {
      if (
        config["users"] == null || !Array.isArray(config["users"]) ||
        config["users"].length === 0
      ) {
        return UserState.NO_USERS;
      }
      if (update["message"]["from"]["username"] == null) {
        return UserState.NO_USER_NAME;
      }
      if (!config["users"].includes(update["message"]["from"]["username"])) {
        return UserState.NOT_ALLOWED;
      }
      return UserState.ALLOWED;
    }

    // Actually append to section.
    appendText(update) {
      if (this.post == null) {
        return;
      }
      if (this.post["text"] == null) {
        this.post["text"] = update["message"]["text"];
        return;
      }
      this.post["text"] += update["message"]["text"];
    }

    appendImages(update) {
      if (this.post == null) {
        return;
      }
      if (this.post["images"] == null) {
        this.post["images"] = [update["message"]["photo"]];
        return;
      }
      // Push an array of different size photos.
      this.post["images"].push(update["message"]["photo"]);
    }

    appendAuthors(update) {
      if (this.post == null) {
        return;
      }
      if (this.post["authors"] == null) {
        this.post["authors"] = [update["message"]["text"].trim()];
        return;
      }
      this.post["authors"].push(update["message"]["text"].trim());
    }

    appendTags(update) {
      if (this.post == null) {
        return;
      }
      if (this.post["tags"] == null) {
        this.post["tags"] = [update["message"]["text"].trim()];
        return;
      }
      this.post["tags"].push(update["message"]["text"].trim());
    }

    appendDate(update) {
      if (this.post == null) {
        return;
      }
      this.post["date"] = new Date(update["message"]["text"].trim()).getTime();
    }

    appendDeletedPosts(update) {
      if (this.deletedPosts == null) {
        return;
      }
      this.deletedPosts.push(update["message"]["text"].trim());
    }

    // Handle section changing.
    // `onCreate` will override parent method...so call this `onCreateCommand`.
    async onCreateCommand(update) {
      if (!this.checkState(State.IDLE)) {
        return;
      }
      this.state = State.CREATE;
      this.post = {
        "text": null,
        "images": null,
        "authors": null,
        "tags": null,
        "date": null
      };
      await this.botAPI.sendChatAction(
        update["message"]["chat"]["id"], "typing"
      );
      await this.botAPI.sendMessage(
        update["message"]["chat"]["id"],
        "Please attach images or text.",
        {"replyToMessageID": update["message"]["message_id"]}
      );
    }

    async onDeleteCommand(update) {
      if (!this.checkState(State.IDLE)) {
        return;
      }
      this.state = State.DELETE;
      this.deletedPosts = [];
      await this.botAPI.sendChatAction(
        update["message"]["chat"]["id"], "typing"
      );
      await this.botAPI.sendMessage(
        update["message"]["chat"]["id"],
        "Please attach deleted IDs, each message contains one ID.",
        {"replyToMessageID": update["message"]["message_id"]}
      );
    }

    async onTextCommand(update) {
      // From IDLE or DELETE to TEXT is not allowed.
      if (!this.checkState(
        State.CREATE, State.TEXT, State.IMAGES, State.AUTHORS, State.TAGS,
        State.DATE
      )) {
        return;
      }
      this.state = State.TEXT;
      await this.botAPI.sendChatAction(
        update["message"]["chat"]["id"], "typing"
      );
      await this.botAPI.sendMessage(
        update["message"]["chat"]["id"],
        "Please attach text.",
        {"replyToMessageID": update["message"]["message_id"]}
      );
    }

    async onImagesCommand(update) {
      // From IDLE or DELETE to IMAGES is not allowed.
      if (!this.checkState(
        State.CREATE, State.TEXT, State.IMAGES, State.AUTHORS, State.TAGS,
        State.DATE
      )) {
        return;
      }
      this.state = State.IMAGES;
      await this.botAPI.sendChatAction(
        update["message"]["chat"]["id"], "typing"
      );
      await this.botAPI.sendMessage(
        update["message"]["chat"]["id"],
        "Please attach images.",
        {"replyToMessageID": update["message"]["message_id"]}
      );
    }

    async onAuthorsCommand(update) {
      // From IDLE or DELETE to AUTHORS is not allowed.
      if (!this.checkState(
        State.CREATE, State.TEXT, State.IMAGES, State.AUTHORS, State.TAGS,
        State.DATE
      )) {
        return;
      }
      this.state = State.AUTHORS;
      await this.botAPI.sendChatAction(
        update["message"]["chat"]["id"], "typing"
      );
      await this.botAPI.sendMessage(
        update["message"]["chat"]["id"],
        "Please attach authors, each message contains one author.",
        {"replyToMessageID": update["message"]["message_id"]}
      );
    }

    async onTagsCommand(update) {
      // From IDLE or DELETE to TAGS is not allowed.
      if (!this.checkState(
        State.CREATE, State.TEXT, State.IMAGES, State.AUTHORS, State.TAGS,
        State.DATE
      )) {
        return;
      }
      this.state = State.TAGS;
      await this.botAPI.sendChatAction(
        update["message"]["chat"]["id"], "typing"
      );
      await this.botAPI.sendMessage(
        update["message"]["chat"]["id"],
        "Please attach tags, each message contains one tag.",
        {"replyToMessageID": update["message"]["message_id"]}
      );
    }

    async onDateCommand(update) {
      // From IDLE or DELETE to CREATED is not allowed.
      if (!this.checkState(
        State.CREATE, State.TEXT, State.IMAGES, State.AUTHORS, State.TAGS,
        State.DATE
      )) {
        return;
      }
      this.state = State.DATE;
      await this.botAPI.sendChatAction(
        update["message"]["chat"]["id"], "typing"
      );
      await this.botAPI.sendMessage(
        update["message"]["chat"]["id"],
        "Please add created time and date in YYYY-MM-DD HH:mm:ss format.",
        {"replyToMessageID": update["message"]["message_id"]}
      );
    }

    makeDirName(committed, subdirs) {
      // Use timestamp as ID and dir name.
      let baseName = `${committed}`;
      // Timestamps may start with `-`, replace it with `n` because dir starts
      // with `-` is hard to handle for shell commands.
      // But is 2022 now, is there anyone using it in 1969?
      if (baseName.charAt(0) === "-") {
        baseName = `n${baseName.substring(1)}`;
      }
      let dirName = baseName;
      let i = 0;
      // If conflict, find a new name. Very little chance.
      while (subdirs.includes(dirName)) {
        dirName = `${baseName}-${++i}`;
      }
      return dirName;
    }

    async downloadFile(fileID, dirName, fileName) {
      const file = await this.botAPI.getFile(fileID);
      const downloadURL = `https://api.telegram.org/file/bot${this.botAPI.token}/${file["file_path"]}`;
      const buffer = await botUtils.get(downloadURL);
      await fs.writeFile(path.join(downloadDir, dirName, fileName), buffer);
      return fileName;
    }

    async sendCodeBlock(update, content, opts = {}) {
      await this.botAPI.sendChatAction(
        update["message"]["chat"]["id"], "typing"
      );
      await this.botAPI.sendMessage(
        update["message"]["chat"]["id"],
        [
          `${opts["header"] || ""}:`,
          `\`\`\`${opts["lang"] || ""}`,
          `${content}`,
          `\`\`\``
        ].join("\n"),
        {
          "replyToMessageID": update["message"]["message_id"],
          "parseMode": "MarkdownV2"
        }
      );
    }

    async commitCreate(update, subdirs) {
      if (this.post != null &&
          (this.post["text"] != null || this.post["images"] != null)) {
        // We always use committed time as dir name to prevent conflict.
        const committed = Date.now();
        const dirName = this.makeDirName(committed, subdirs);
        try {
          await fs.mkdir(path.join(downloadDir, dirName));
          const fileNames = await Promise.all(
            this.post["images"].map((image, i) => {
              let maxSize = image[0];
              for (const size of image) {
                if (maxSize["file_size"] < size["file_size"]) {
                  maxSize = size;
                }
              }
              const fileName = `${i + 1}.jpg`;
              return this.downloadFile(maxSize["file_id"], dirName, fileName);
            })
          );
          const metadata = {
            "dir": dirName,
            "created": this.post["date"] || committed,
            "layout": "album",
            "text": this.post["text"],
            "images": fileNames,
            "authors": this.post["authors"],
            "tags": this.post["tags"]
          };
          await fs.writeFile(
            path.join(downloadDir, dirName, "index.json"),
            JSON.stringify(metadata),
            "utf8"
          );
          await this.botAPI.sendChatAction(
            update["message"]["chat"]["id"], "typing"
          );
          await this.botAPI.sendMessage(
            update["message"]["chat"]["id"],
            `Created \`${dirName}\`\\.`,
            {
              "replyToMessageID": update["message"]["message_id"],
              "parseMode": "MarkdownV2"
            }
          );
        } catch (error) {
          botLogger.warn(error);
          try {
            await fs.rm(
              path.join(downloadDir, dirName),
              {"recursive": true, "force": true}
            );
          } catch (error) {
          }
          await this.sendCodeBlock(
            update,
            JSON.stringify(error, null, "  "),
            {"header": "error", "lang": "json"}
          );
        }
      }
    }

    async commitDelete(update) {
      const subdirs = await fs.readdir(downloadDir);
      if (this.deletedPosts != null) {
        const existingPosts = this.deletedPosts.filter((ele) => {
          return subdirs.includes(ele);
        });
        try {
          await Promise.all(existingPosts.map((ele) => {
            return fs.rm(path.join(downloadDir, ele), {"recursive": true});
          }));
          await this.botAPI.sendChatAction(
            update["message"]["chat"]["id"], "typing"
          );
          await this.botAPI.sendMessage(
            update["message"]["chat"]["id"],
            `Deleted ${existingPosts.map((ele) => {
              return `\`${ele}\``;
            }).join(", ")}\\.`,
            {
              "replyToMessageID": update["message"]["message_id"],
              "parseMode": "MarkdownV2"
            }
          );
        } catch (error) {
          botLogger.warn(error);
          await this.sendCodeBlock(
            update,
            JSON.stringify(error, null, "  "),
            {"header": "error", "lang": "json"}
          );
        }
      }
    }

    runBuildCommand(update) {
      // committing is global.
      if (!config["buildCommand"] || !config["buildCommandWorkDir"]) {
        committing = false;
      } else {
        exec(
          config["buildCommand"], {"cwd": config["buildCommandWorkDir"]},
          async (error, stdout, stderr) => {
            committing = false;
            // We always send stdout and stderr, so don't return here.
            if (error != null) {
              botLogger.warn(`exec error: ${error}`);
              await this.botAPI.sendChatAction(
                update["message"]["chat"]["id"], "typing"
              );
              await this.botAPI.sendMessage(
                update["message"]["chat"]["id"],
                "Build command failed, committing task done.",
                {"replyToMessageID": update["message"]["message_id"]}
              );
              await this.sendCodeBlock(
                update,
                JSON.stringify(error, null, "  "),
                {"header": "error", "lang": "json"}
              );
            } else {
              await this.botAPI.sendChatAction(
                update["message"]["chat"]["id"], "typing"
              );
              await this.botAPI.sendMessage(
                update["message"]["chat"]["id"],
                "Build command succeeded, committing task done.",
                {"replyToMessageID": update["message"]["message_id"]}
              );
            }
            if (stdout != null && stdout.length !== 0) {
              botLogger.log(`stdout: ${stdout}`);
              await this.sendCodeBlock(update, stdout, {"header": "stdout"});
            }
            if (stderr != null && stderr.length !== 0) {
              botLogger.warn(`stderr: ${stderr}`);
              await this.sendCodeBlock(update, stderr, {"header": "stderr"});
            }
          }
        );
      }
    }

    async onCommitCommand(update) {
      if (!this.checkState(
        State.CREATE, State.DELETE, State.TEXT, State.IMAGES, State.AUTHORS,
        State.TAGS, State.DATE
      )) {
        return;
      }
      // committing is global.
      if (committing) {
        await this.botAPI.sendChatAction(
          update["message"]["chat"]["id"], "typing"
        );
        await this.botAPI.sendMessage(
          update["message"]["chat"]["id"],
          "There is already a committing task running, please wait for it and re-commit after it finishes.",
          {"replyToMessageID": update["message"]["message_id"]}
        );
      }
      committing = true;
      const subdirs = await fs.readdir(downloadDir);
      if (this.checkState(State.DELETE)) {
        await this.commitDelete(update, subdirs);
      } else {
        await this.commitCreate(update, subdirs);
      }
      this.runBuildCommand(update);
      this.state = State.IDLE;
      this.reset();
    }

    async onCancelCommand(update) {
      if (!this.checkState(
        State.CREATE, State.DELETE, State.TEXT, State.IMAGES, State.AUTHORS,
        State.TAGS, State.DATE
      )) {
        return;
      }
      this.state = State.IDLE;
      this.reset();
      await this.botAPI.sendChatAction(
        update["message"]["chat"]["id"], "typing"
      );
      await this.botAPI.sendMessage(
        update["message"]["chat"]["id"],
        "Cancelled.",
        {"replyToMessageID": update["message"]["message_id"]}
      );
    }

    onCommand(update) {
      for (const command in this.commandHandlers) {
        if (this.isMyCommand(update, command)) {
          this.commandHandlers[command](update);
          return true;
        }
      }
      return false;
    }

    processText(update) {
      this.refreshTimer();
      // Handle command first. If not a command, add it to current section.
      if (this.onCommand(update)) {
        return;
      }
      switch (this.state) {
      // By default text message is handled as text.
      case State.CREATE:
      case State.TEXT:
      case State.IMAGES:
        this.appendText(update);
        break;
      case State.AUTHORS:
        this.appendAuthors(update);
        break;
      case State.TAGS:
        this.appendTags(update);
        break;
      case State.DATE:
        this.appendDate(update);
        break;
      case State.DELETE:
        this.appendDeletedPosts(update);
      default:
        break;
      }
    }

    processImages(update) {
      this.refreshTimer();
      switch (this.state) {
      // By default images message is handled as images. Images are not conflict
      // with text states.
      case State.CREATE:
      case State.TEXT:
      case State.IMAGES:
      case State.AUTHORS:
      case State.TAGS:
      case State.DATE:
        this.appendImages(update);
        break;
      default:
        break;
      }
    }
  }

  // This should be per-chat.
  await new BotMaster(
    botAPI, ImageCollectorBot, botUtils.perChatID, {botLogger}
  ).loop({
    "startCallback": () => {
      botLogger.log("Set commands because of start.");
      return botAPI.setMyCommands(JSON.stringify(myCommands));
    }
  });
})();
