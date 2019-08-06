'use babel';

// eslint-disable-next-line import/extensions, import/no-extraneous-dependencies
import { CompositeDisposable } from 'atom';
import hasValidScope from './validate';

// Dependencies
let helpers;
let dirname;
let stylelint;

function loadDeps() {
  if (!helpers) {
    helpers = require('./helpers');
  }
  if (!dirname) {
    ({ dirname } = require('path'));
  }
  if (!stylelint) {
    stylelint = require('stylelint');
  }
}

export default {
  activate() {
    this.idleCallbacks = new Set();
    let depsCallbackID;
    const installLinterStylelintDeps = () => {
      this.idleCallbacks.delete(depsCallbackID);
      if (!atom.inSpecMode()) {
        require('atom-package-deps').install('linter-stylelint-plus');
      }
      loadDeps();
    };
    depsCallbackID = window.requestIdleCallback(installLinterStylelintDeps);
    this.idleCallbacks.add(depsCallbackID);

    this.baseScopes = [];
    this.configOverrides = {};

    this.subscriptions = new CompositeDisposable();
    this.subscriptions.add(
      atom.config.observe('linter-stylelint-plus.disableWhenNoConfig', (value) => {
        this.disableWhenNoConfig = value;
        if (this.useStandard && this.disableWhenNoConfig) {
          // Disable using the standard if it is desired to stop linting with
          // no configuration
          atom.config.set('linter-stylelint-plus.useStandard', false);
        }
      }),
      atom.config.observe('linter-stylelint-plus.useStandard', (value) => {
        this.useStandard = value;
        if (this.useStandard && this.disableWhenNoConfig) {
          // Disable disabling linting when there is no configuration as the
          // standard configuration will always be available.
          atom.config.set('linter-stylelint-plus.disableWhenNoConfig', false);
        }
      }),
      atom.config.observe('linter-stylelint-plus.showIgnored', (value) => {
        this.showIgnored = value;
      }),
      atom.config.observe('core.excludeVcsIgnoredPaths', (value) => {
        this.coreIgnored = value;
      }),
      atom.config.observe('linter-stylelint-plus.fixOnSave', (value) => {
        this.fixOnSave = value;
      }),
      atom.config.observe('linter-stylelint-plus.baseScopes', (scopes) => {
        // Remove any old scopes
        this.baseScopes.splice(0, this.baseScopes.length);
        // Add the current scopes
        Array.prototype.push.apply(this.baseScopes, scopes);
      }),
      atom.config.observe('linter-stylelint-plus.configOverrides', (value) => {
        try {
          this.configOverrides = JSON.parse(value);
        } catch (e) {
          this.configOverrides = {};
        }
      })
    );

    const textBuffers = new Map();
    this.subscriptions.add(atom.workspace.observeTextEditors((editor) => {
      const buffer = editor.getBuffer();
      if (!textBuffers.has(buffer)) {
        textBuffers.set(buffer, buffer.onWillSave(() => {
          if (this.fixOnSave && hasValidScope(editor, this.baseScopes)) {
            return this.fixJob(editor);
          }
          return Promise.resolve();
        }));
        buffer.onDidDestroy(() => {
          // Maybe this is handled in the destruction of the buffer itself?
          textBuffers.get(buffer).dispose();
          textBuffers.delete(buffer);
        });
      }
    }));
  },

  deactivate() {
    this.idleCallbacks.forEach(callbackID => window.cancelIdleCallback(callbackID));
    this.idleCallbacks.clear();
    this.subscriptions.dispose();
  },

  fixJob(editor) {
    // Silently return if the editor is invalid
    if (!editor || !atom.workspace.isTextEditor(editor)) {
      return Promise.resolve(null);
    }

    // Do not try to make fixes on an empty file
    const text = editor.getText();
    if (text.length === 0) {
      return Promise.resolve(null);
    }

    return this.provideLinter().lint(editor, { shouldFix: true });
  },

  provideLinter() {
    return {
      name: 'stylelint',
      grammarScopes: this.baseScopes,
      scope: 'file',
      lintsOnChange: true,
      lint: async (editor, { shouldFix } = {}) => {
        // Force the dependencies to load if they haven't already
        loadDeps();

        helpers.startMeasure('linter-stylelint-plus: Lint');

        const filePath = editor.getPath();
        const text = editor.getText();

        if (!text) {
          helpers.endMeasure('linter-stylelint-plus: Lint');
          return [];
        }

        const options = {
          code: text,
          codeFilename: filePath,
          fix: Boolean(shouldFix),
          configOverrides: this.configOverrides
        };

        const scopes = editor.getLastCursor().getScopeDescriptor().getScopesArray();
        if (scopes.includes('source.css.scss') || scopes.includes('source.scss')) {
          options.syntax = 'scss';
        } else if (scopes.includes('source.css.less') || scopes.includes('source.less')) {
          options.syntax = 'less';
        } else if (scopes.includes('source.css.postcss.sugarss')) {
          options.syntax = 'sugarss';
        }

        if (this.coreIgnored) {
          // When Atom (and thus Linter) is set to allow ignored files, tell
          // Stylelint to do the same.
          options.disableDefaultIgnores = true;
        }

        helpers.startMeasure('linter-stylelint-plus: Create Linter');
        const stylelintLinter = await stylelint.createLinter();
        helpers.endMeasure('linter-stylelint-plus: Create Linter');

        helpers.startMeasure('linter-stylelint-plus: Config');
        let foundConfig;
        try {
          foundConfig = await stylelintLinter.getConfigForFile(filePath);
        } catch (error) {
          if (!/No configuration provided for .+/.test(error.message)) {
            helpers.endMeasure('linter-stylelint-plus: Config');
            // If we got here, stylelint failed to parse the configuration
            // there's no point of re-linting if useStandard is true, because the
            // user does not have the complete set of desired rules parsed
            atom.notifications.addError('Unable to parse stylelint configuration', {
              detail: error.message,
              dismissable: true
            });
            helpers.endMeasure('linter-stylelint-plus: Lint');
            return [];
          }
        }
        helpers.endMeasure('linter-stylelint-plus: Config');

        if (foundConfig) {
          // We have a configuration from Stylelint
          options.config = foundConfig.config;
          options.configBasedir = dirname(foundConfig.filepath);
        } else if (this.disableWhenNoConfig) {
          // No configuration, and linting without one is disabled
          helpers.endMeasure('linter-stylelint-plus: Lint');
          return [];
        } else if (this.useStandard) {
          // No configuration, but using the standard is enabled
          const defaultConfig = helpers.getDefaultConfig(options.syntax);
          options.config = { rules: defaultConfig.rules };
          if (defaultConfig.extends) {
            options.config.extends = defaultConfig.extends;
          }
          options.configBasedir = defaultConfig.configBasedir;
        }

        helpers.startMeasure('linter-stylelint-plus: Check ignored');
        let fileIsIgnored;
        try {
          fileIsIgnored = await stylelintLinter.isPathIgnored(filePath);
        } catch (error) {
          // Do nothing, configuration errors should have already been caught and thrown above
        }
        helpers.endMeasure('linter-stylelint-plus: Check ignored');

        if (fileIsIgnored) {
          helpers.endMeasure('linter-stylelint-plus: Lint');
          if (this.showIgnored) {
            return [{
              severity: 'warning',
              excerpt: 'This file is ignored',
              location: {
                file: filePath,
                position: helpers.createRange(editor)
              }
            }];
          }
          return [];
        }
        const settings = {
          showIgnored: this.showIgnored
        };

        return helpers.runStylelint(editor, options, filePath, settings);
      }
    };
  }
};
