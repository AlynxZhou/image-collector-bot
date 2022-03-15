const fs = require("fs");
const path = require("path");
const {
    BotMaster,
    BotServant,
    BotAPI,
    BotLogger,
    botUtils
  } = require("aztgbot");
const config = require("config.json");
const botAPI = new BotAPI(config["token"]);
const botLogger = new BotLogger({"debug": false});
const workDir = config["workDir"];

const State = {
  "IDLE": 0,
  "CREATE": 1,
  "DELETE": 2,
  "TEXT": 3,
  "IMAGES": 4,
  "AUTHORS": 5,
  "TAGS": 6
};

const myCommands = {
  "command": "create", "description": "Begin post creating operation.",
  "command": "delete", "description": "Begin post deleting operation.",
  "command": "text", "description": "Add a text section for this post.",
  "command": "images", "description": "Add an images section for this post.",
  "command": "authors", "description": "Add an authors section for this post.",
  "command": "tags", "description": "Add a tags section for this post.",
  "command": "commit", "description": "End and submit operation.",
  "command": "cancel", "description": "End and discard operation."
};

class ImageCollectorBot extends BotServant {
  // timeout: how many seconds to wait before automatically cancel uncommitted
  // operation. By default a servant will be destoryed after 5 min, so don't be
  // too long.
  constructor(botAPI, identifier, botID, botName, timeout = 3 * 60) {
    super(botAPI, identifier, botID, botName);
    this.timeout = timeout;
    this.commandHandlers = {
      "create": this.onCreate.bind(this),
      "delete": this.onDelete.bind(this),
      "text": this.onText.bind(this),
      "images": this.onImages.bind(this),
      "authors": this.onAuthors.bind(this),
      "tags": this.onTags.bind(this),
      "commit": this.onCommit.bind(this),
      "cancel": this.onCancel.bind(this)
    };
    this.state = State.IDLE;
    this.post = null;
    this.deletedPosts = null;
    this.timeoutID = null;
  }

  // override
  processUpdate(update) {
    if (update["message"] == null) {
      return;
    }
    if (update["message"]["text"] != null) {
      this.processText(update);
    }
    if (update["message"]["photo"] != null) {
      this.processImages(update);
    }
    // TODO: uncompressed images maybe sent as files.
  }

  isMyCommand(update, command) {
    return update["message"]["text"].startsWith(`/${command}`) ||
      update["message"]["text"].startsWith(`/${command}@${botName}`);
  }

  reset() {
    this.state = State.IDLE;
    this.post = null;
    this.deletedPosts = null;
  }

  refreshTimer() {
    if (this.timeoutID != null) {
      this.clearTimeout(this.timeoutID);
    }
    this.timeoutID = setTimeout(() => {
      this.timeoutID = null;
      this.reset();
    }, this.timeout);
  }

  checkState(...validStates) {
    for (const state of validStates) {
      if (this.state === state) {
        return true;
      }
    }
    return false;
  }

  // Actually append to section.
  appendText(update) {
    if (this.post == null) {
      return;
    }
    this.post["text"] += update["message"]["text"];
  }

  appendImages(update) {
    if (this.post == null) {
      return;
    }
    this.post["images"].push(...update["message"]["photo"]);
  }

  appendAuthors(update) {
    if (this.post == null) {
      return;
    }
    this.post["authors"].push(update["message"]["text"].trim());
  }

  appendTags(update) {
    if (this.post == null) {
      return;
    }
    this.post["tags"].push(update["message"]["text"].trim());
  }

  appendDeletedPosts(update) {
    if (this.deletedPosts == null) {
      return;
    }
    this.deletedPosts.push(update["message"]["text"].trim());
  }
  
  // Handle section changing.
  onCreate(update) {
    if (!this.checkState(State.IDLE)) {
      return;
    }
    this.state = State.CREATE;
    this.post = {
      "text": "",
      "images": [],
      "authors": [],
      "tags": []
    };
  }

  onDelete(update) {
    if (!this.checkState(State.IDLE)) {
      return;
    }
    this.state = State.DELETE;
    this.deletedPosts = [];
  }

  onText(update) {
    // From IDLE or DELETE to TEXT is not allowed.
    if (!this.checkState(State.CREATE, State.TEXT, State.IMAGES, State.AUTHORS,
                         State.TAGS)) {
      return;
    }
    this.state = State.TEXT;
  }

  onImages(update) {
    // From IDLE or DELETE to IMAGES is not allowed.
    if (!this.checkState(State.CREATE, State.TEXT, State.IMAGES, State.AUTHORS,
                         State.TAGS)) {
      return;
    }
    this.state = State.IMAGES;
  }

  onAuthors(update) {
    // From IDLE or DELETE to AUTHORS is not allowed.
    if (!this.checkState(State.CREATE, State.TEXT, State.IMAGES, State.AUTHORS,
                         State.TAGS)) {
      return;
    }
    this.state = State.AUTHORS;
  }

  onTags(update) {
    // From IDLE or DELETE to TAGS is not allowed.
    if (!this.checkState(State.CREATE, State.TEXT, State.IMAGES, State.AUTHORS,
                         State.TAGS)) {
      return;
    }
    this.state = State.TAGS;
  }

  onCommit(update) {
    if (!this.checkState(State.CREATE, State.TEXT, State.IMAGES, State.AUTHORS,
                         State.TAGS)) {
      return;
    }
    // TODO: Write dirs and files into disk or delete dirs.
    this.state = State.IDLE;
    this.reset();
  }

  onCancel(update) {
    if (!this.checkState(State.CREATE, State.TEXT, State.IMAGES, State.AUTHORS,
                         State.TAGS)) {
      return;
    }
    this.state = State.IDLE;
    this.reset();
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
    switch(this.state) {
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
    case State.DELETE:
      this.appendDeletedPosts(update);
    default:
      break;
    }
  }

  processImages(update) {
    this.refreshTimer();
    switch(this.state) {
    // By default images message is handled as images. Images are not conflict
    // with text states.
    case State.CREATE:
    case State.TEXT:
    case State.IMAGES:
    case State.AUTHORS:
    case State.TAGS:
      this.appendImages(update);
      break;
    default:
      break;
    }
  }
}

new BotMaster(botAPI, ImageCollectorBot, botUtils.perFromID, {botLogger}).loop({
  "startCallback": () => {
    botLogger.log("Set commands because of start.");
    return botAPI.setMyCommands(JSON.stringify(myCommands));
  },
  "stopCallback": () => {
    // TODO: finish commit.
  }
});
