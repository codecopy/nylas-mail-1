import _ from 'underscore'
import EventEmitter from 'events';
import NylasStore from 'nylas-store';

import Message from '../models/message'
import Actions from '../actions'
import AccountStore from './account-store'
import ContactStore from './contact-store'
import DatabaseStore from './database-store'
import UndoStack from '../../undo-stack'
import DraftHelpers from '../stores/draft-helpers'
import {Composer as ComposerExtensionRegistry} from '../../registries/extension-registry'
import SyncbackDraftTask from '../tasks/syncback-draft-task'

const MetadataChangePrefix = 'metadata.';
let DraftStore = null;

/**
Public: As the user interacts with the draft, changes are accumulated in the
DraftChangeSet associated with the store session. The DraftChangeSet does two things:

1. It debounces changes and calls Actions.saveDraft() at a reasonable interval.

2. It exposes `applyToModel`, which allows you to optimistically apply changes
  to a draft object. When the session vends the draft, it passes it through this
  function to apply uncommitted changes. This means the Draft provided by the
  DraftEditingSession will always relfect recent changes, even though they're
  written to the database intermittently.

Section: Drafts
*/
class DraftChangeSet extends EventEmitter {
  constructor(callbacks) {
    super();
    this.callbacks = callbacks;
    this._commitChain = Promise.resolve()
    this._pending = {}
    this._saving = {}
    this._timer = null;
  }

  teardown() {
    this._pending = {};
    this._saving = {};
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  add(changes, {doesNotAffectPristine} = {}) {
    this.callbacks.onWillAddChanges(changes);
    this._pending = Object.assign(this._pending, changes);
    if (!doesNotAffectPristine) {
      this._pending.pristine = false;
    }
    this.callbacks.onDidAddChanges(changes);

    if (this._timer) {
      clearTimeout(this._timer);
    }
    this._timer = setTimeout(() => this.commit(), 10000);
  }

  addPluginMetadata(pluginId, metadata) {
    const changes = {};
    changes[`${MetadataChangePrefix}${pluginId}`] = metadata;
    this.add(changes, {doesNotAffectPristine: true});
  }

  commit({noSyncback} = {}) {
    if (this._timer) {
      clearTimeout(this._timer);
    }
    const commitSemaphored = () => {
      if (Object.keys(this._pending).length === 0) {
        return Promise.resolve(true);
      }

      this._saving = this._pending;
      this._pending = {};
      return this.callbacks.onCommit({noSyncback}).then(() => {
        this._saving = {}
      });
    };

    this._commitChain = this._commitChain.then(commitSemaphored, commitSemaphored);
    return this._commitChain;
  }

  applyToModel(model) {
    if (model) {
      const changesToApply = Object.entries(this._saving).concat(Object.entries(this._pending));
      for (const [key, val] of changesToApply) {
        if (key.startsWith(MetadataChangePrefix)) {
          model.applyPluginMetadata(key.split(MetadataChangePrefix).pop(), val);
        } else {
          model[key] = val;
        }
      }
    }
    return model;
  }
}

/**
Public: DraftEditingSession is a small class that makes it easy to implement components
that display Draft objects or allow for interactive editing of Drafts.

1. It synchronously provides an instance of a draft via `draft()`, and
   triggers whenever that draft instance has changed.

2. It provides an interface for modifying the draft that transparently
   batches changes, and ensures that the draft provided via `draft()`
   always has pending changes applied.

Section: Drafts
*/
export default class DraftEditingSession extends NylasStore {

  static DraftChangeSet = DraftChangeSet;

  constructor(headerMessageId, draft = null) {
    super();

    DraftStore = DraftStore || require('./draft-store').default; // eslint-disable-line
    this.listenTo(DraftStore, this._onDraftChanged)

    this.headerMessageId = headerMessageId;
    this._draft = false;
    this._draftPristineBody = null;
    this._destroyed = false;
    this._undoStack = new UndoStack();

    this.changes = new DraftChangeSet({
      onWillAddChanges: this.changeSetWillAddChanges,
      onDidAddChanges: this.changeSetDidAddChanges,
      onCommit: () => this.changeSetCommit(), // for specs
    });

    if (draft) {
      this._draftPromise = this._setDraft(draft);
    }

    this.prepare();
  }

  // Public: Returns the draft object with the latest changes applied.
  //
  draft() {
    if (!this._draft) {
      return null;
    }
    this.changes.applyToModel(this._draft);
    return this._draft.clone();
  }

  // Public: Returns the initial body of the draft when it was pristine, or null if the
  // draft was never pristine in this editing session. Useful for determining if the
  // body is still in an unchanged / empty state.
  //
  draftPristineBody() {
    return this._draftPristineBody;
  }

  prepare() {
    this._draftPromise = this._draftPromise || DatabaseStore
    .findBy(Message, {headerMessageId: this.headerMessageId, draft: true})
    .include(Message.attributes.body)
    .then((draft) => {
      if (this._destroyed) {
        return Promise.reject(new Error("Draft has been destroyed."));
      }
      if (!draft) {
        return Promise.reject(new Error(`Assertion Failure: Draft ${this.headerMessageId} not found.`));
      }
      return this._setDraft(draft)
    });
    return this._draftPromise;
  }

  teardown() {
    this.stopListeningToAll();
    this.changes.teardown();
    this._destroyed = true;
  }

  validateDraftForSending() {
    const warnings = []
    const errors = []
    const allRecipients = [].concat(this._draft.to, this._draft.cc, this._draft.bcc)
    const bodyIsEmpty = (this._draft.body === this.draftPristineBody()) || (this._draft.body === "<br>")
    const forwarded = DraftHelpers.isForwardedMessage(this._draft);
    const hasAttachment = (this._draft.files && this._draft.files.length > 0);

    for (const contact of allRecipients) {
      if (!ContactStore.isValidContact(contact)) {
        errors.push(`${contact.email} is not a valid email address - please remove or edit it before sending.`)
      }
    }

    if (allRecipients.length === 0) {
      errors.push('You need to provide one or more recipients before sending the message.');
    }

    if (errors.length > 0) {
      return {errors, warnings};
    }

    if (this._draft.subject.length === 0) {
      warnings.push('without a subject line');
    }

    if (DraftHelpers.messageMentionsAttachment(this._draft) && !hasAttachment) {
      warnings.push('without an attachment');
    }

    if (bodyIsEmpty && !forwarded && !hasAttachment) {
      warnings.push('without a body');
    }

    // Check third party warnings added via Composer extensions
    for (const extension of ComposerExtensionRegistry.extensions()) {
      if (!extension.warningsForSending) {
        continue;
      }
      warnings.push(...extension.warningsForSending({draft: this._draft}));
    }

    return {errors, warnings};
  }

  // This function makes sure the draft is attached to a valid account, and changes
  // it's accountId if the from address does not match the account for the from
  // address
  //
  // If the account is updated it makes a request to delete the draft with the
  // old accountId
  ensureCorrectAccount({noSyncback} = {}) {
    const account = AccountStore.accountForEmail(this._draft.from[0].email);
    if (!account) {
      return Promise.reject(new Error("DraftEditingSession::ensureCorrectAccount - you can only send drafts from a configured account."))
    }

    if (account.id !== this._draft.accountId) {
      // todo bg decide what to do here to sync
      // NylasAPIHelpers.makeDraftDeletionRequest(this._draft)
      this.changes.add({
        accountId: account.id,
        version: null,
        threadId: null,
        replyToMessageId: null,
      });
      return this.changes.commit({noSyncback}).thenReturn(this);
    }
    return Promise.resolve(this);
  }

  _setDraft(draft) {
    if (draft.body === undefined) {
      throw new Error("DraftEditingSession._setDraft - new draft has no body!");
    }

    const extensions = ComposerExtensionRegistry.extensions()

    // Run `extensions[].unapplyTransformsForSending`
    const fragment = document.createDocumentFragment()
    const draftBodyRootNode = document.createElement('root')
    fragment.appendChild(draftBodyRootNode);
    draftBodyRootNode.innerHTML = draft.body;

    return Promise.each(extensions, (ext) => {
      if (ext.applyTransformsForSending && ext.unapplyTransformsForSending) {
        Promise.resolve(ext.unapplyTransformsForSending({
          draftBodyRootNode: draftBodyRootNode,
          draft: draft,
        }));
      }
    }).then(() => {
      draft.body = draftBodyRootNode.innerHTML;
      this._draft = draft;

      // We keep track of the draft's initial body if it's pristine when the editing
      // session begins. This initial value powers things like "are you sure you want
      // to send with an empty body?"
      if (draft.pristine) {
        this._draftPristineBody = draft.body;
        this._undoStack.save(this._snapshot());
      }

      this.trigger();
      return Promise.resolve(this);
    });
  }

  _onDraftChanged = (change) => {
    if (change === undefined) {
      return;
    }
    // We don't accept changes unless our draft object is loaded
    if (!this._draft) {
      return;
    }

    // If our draft has been changed, only accept values which are present.
    // If `body` is undefined, assume it's not loaded. Do not overwrite old body.
    const nextDraft = change.objects.filter((obj) =>
      obj.headerMessageId === this._draft.headerMessageId
    ).pop();

    if (nextDraft) {
      const nextValues = {};
      for (const [key] of Object.entries(Message.attributes)) {
        if (key === 'headerMessageId') {
          continue;
        }
        if (nextDraft[key] === undefined) {
          continue;
        }
        nextValues[key] = nextDraft[key];
      }
      this._setDraft(Object.assign(new Message(), this._draft, nextValues));
      this.trigger();
    }
  }

  // TODO BG noSyncback is gone
  async changeSetCommit() {
    if (this._destroyed || !this._draft) {
      return;
    }

    // Set a variable here to protect againg this._draft getting set from
    // underneath us
    const inMemoryDraft = this._draft;
    const draft = await DatabaseStore
      .findBy(Message, {headerMessageId: inMemoryDraft.headerMessageId})
      .include(Message.attributes.body);

    // This can happen if we get a "delete" delta, or something else
    // strange happens. In this case, we'll use the this._draft we have in
    // memory to apply the changes to. On the `persistModel` in the
    // next line it will save the correct changes. The
    // `SyncbackDraftTask` may then fail due to differing Ids not
    // existing, but if this happens it'll 404 and recover gracefully
    // by creating a new draft
    const baseDraft = draft || inMemoryDraft;
    const updatedDraft = this.changes.applyToModel(baseDraft);
    console.log("Queueing SyncbackDraftTask");
    Actions.queueTask(new SyncbackDraftTask({draft: updatedDraft}));
  }

  // Undo / Redo

  changeSetWillAddChanges = (changes) => {
    if (this._restoring) {
      return;
    }
    const hasBeen300ms = (Date.now() - this._lastAddTimestamp > 300);
    const hasChangedFields = !_.isEqual(Object.keys(changes), this._lastChangedFields)

    this._lastChangedFields = Object.keys(changes);
    this._lastAddTimestamp = Date.now();
    if (hasBeen300ms || hasChangedFields) {
      this._undoStack.save(this._snapshot());
    }
  }

  changeSetDidAddChanges = () => {
    if (this._destroyed) {
      return;
    }
    if (!this._draft) {
      throw new Error("DraftChangeSet was modified before the draft was prepared.")
    }
    this.changes.applyToModel(this._draft);
    this.trigger();
  }

  restoreSnapshot(snapshot) {
    if (!snapshot) {
      return;
    }
    this._restoring = true;
    this.changes.add(snapshot.draft);
    if (this._composerViewSelectionRestore) {
      this._composerViewSelectionRestore(snapshot.selection);
    }
    this._restoring = false;
  }

  undo() {
    this.restoreSnapshot(this._undoStack.saveAndUndo(this._snapshot()))
  }

  redo() {
    this.restoreSnapshot(this._undoStack.redo())
  }

  _snapshot() {
    const snapshot = {
      selection: this._composerViewSelectionRetrieve && this._composerViewSelectionRetrieve(),
      draft: Object.assign({}, this.draft()),
    }
    for (const {pluginId, value} of snapshot.draft.pluginMetadata) {
      snapshot.draft[`${MetadataChangePrefix}${pluginId}`] = value;
    }
    delete snapshot.draft.pluginMetadata;
    return snapshot;
  }
}