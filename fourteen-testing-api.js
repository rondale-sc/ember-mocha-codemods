'use strict';

module.exports = function(file, api) {
  const j = api.jscodeshift;
  const root = j(file.source);

  const SETUP_TYPE_METHODS = ["setupComponentTest"];

  function isSetupTypeMethod(nodePath) {
    return SETUP_TYPE_METHODS.some(name => {
      let matcher = {
        type: "ExpressionStatement",
        expression: { callee: { name } }
      };

      return j.match(nodePath, matcher);
    });
  }

  const LIFE_CYCLE_METHODS = [
    {expression: { callee: { name: 'before' }}},
    {expression: { callee: { name: 'beforeEach' }}},
    {expression: { callee: { name: 'afterEach' }}},
    {expression: { callee: { name: 'after' }}},
  ];

  function isLifecycleHook(node) {
    return LIFE_CYCLE_METHODS.some(matcher => j.match(node, matcher));
  }


  class ModuleInfo {
    constructor(p) {
      this.isEmberMochaDescribe = false;
      this.tests = [];
      this.lifecycles = [];
      let describeBody = p.node.expression.arguments[1].body.body;

      describeBody.forEach(node => {
        if (isSetupTypeMethod(node)) {
          let options = node.expression.arguments[1];
          this.hasIntegrationFlag = options.properties.some(p => p.key.name === "integration");
          this.setupType = this.hasIntegrationFlag ? "setupRenderingTest" : "setupTest";
          this.setupTypeMethodInvocationNode = node.expression;
          this.isEmberMochaDescribe = true;
        }

        if (j.match(node, { expression: { callee: { name: "it" } } })) {
          this.tests.push(node.expression);
        }

        if (isLifecycleHook(node)) {
          this.lifecycles.push(node.expression);
        }
      });
    }

    updateSetupInvocation() {
      this.setupTypeMethodInvocationNode.arguments = [];
      this.setupTypeMethodInvocationNode.callee.name = this.setupType;
    }

    _updateExpressionForTest(expression) {
      if(this.setupType === 'setupRenderingTest') {
        processExpressionForRenderingTest(expression)
      }
    }

    updateTests() {
      this.tests.forEach(e => this._updateExpressionForTest(e));
    }

    updateLifecycles() {
      this.lifecycles.forEach(e => this._updateExpressionForTest(e));
    }
  }

  function findTestHelperUsageOf(collection, property) {
    return collection.find(j.ExpressionStatement, {
      expression: {
        callee: {
          object: {
            type: "ThisExpression"
          },
          property: {
            name: property
          }
        }
      }
    });
  }

  function processExpressionForRenderingTest(testExpression) {
    // mark the test function as an async function
    let testExpressionCollection = j(testExpression);
    let specifiers = new Set();

    // Transform to await render() or await clearRender()
    ["render", "clearRender"].forEach(type => {
      findTestHelperUsageOf(testExpressionCollection, type).forEach(p => {
        specifiers.add(type);

        let expression = p.get("expression");

        let awaitExpression = j.awaitExpression(
          j.callExpression(j.identifier(type), expression.node.arguments)
        );
        expression.replace(awaitExpression);
        p.scope.node.async = true;
      });
    });

    ensureImportWithSpecifiers({
      source: "@ember/test-helpers",
      anchor: "ember-mocha",
      specifiers
    });

    // Migrate `this._element` -> `this.element`
    testExpressionCollection
      .find(j.MemberExpression, {
        object: {
          type: "ThisExpression"
        },
        property: {
          name: "_element"
        }
      })
      .forEach(p => {
        let property = p.get("property");
        property.node.name = "element";
      });
  }

  function ensureImport(source, anchor, method) {
    method = method || "insertAfter";

    let desiredImport = root.find(j.ImportDeclaration, { source: { value: source } });
    if (desiredImport.size() > 0) {
      return desiredImport;
    }

    let newImport = j.importDeclaration([], j.literal(source));
    let anchorImport = root.find(j.ImportDeclaration, { source: { value: anchor } });
    let imports = root.find(j.ImportDeclaration);
    if (anchorImport.size() > 0) {
      anchorImport.at(anchorImport.size() - 1)[method](newImport);
    } else if (imports.size() > 0) {
      // if anchor is not present, always add at the end
      imports.at(imports.size() - 1).insertAfter(newImport);
    } else {
      // if no imports are present, add as first statement
      root.get().node.program.body.unshift(newImport);
    }

    return j(newImport);
  }

  function ensureImportWithSpecifiers(options) {
    let source = options.source;
    let specifiers = options.specifiers;
    let anchor = options.anchor;
    let positionMethod = options.positionMethod;

    let importStatement = ensureImport(source, anchor, positionMethod);
    let combinedSpecifiers = new Set(specifiers);

    importStatement
      .find(j.ImportSpecifier)
      .forEach(i => combinedSpecifiers.add(i.node.imported.name))
      .remove();

    importStatement.get("specifiers").replace(
      Array.from(combinedSpecifiers)
      .sort()
      .map(s => j.importSpecifier(j.identifier(s)))
    );
  }

  function updateToNewEmberMochaImports() {
    let mapping = {
      setupComponentTest: "setupRenderingTest"
    };

    let emberMochaImports = root.find(j.ImportDeclaration, { source: { value: "ember-mocha" } });
    if (emberMochaImports.size() === 0) {
      return;
    }

    // Collect all imports from ember-mocha into local array
    let emberMochaSpecifiers = new Set();

    emberMochaImports
      .find(j.ImportSpecifier)
      .forEach(p => {
        // Map them to the new imports
        let importName = p.node.imported.name;
        let mappedName = mapping[importName] || importName;

        if (importName === "setupComponentTest") {
          root
            .find(j.ExpressionStatement, {
              expression: {
                callee: { name: "describe" }
              }
            })
            .forEach(p => {
              let mod = new ModuleInfo(p);
              emberMochaSpecifiers.add(mod.setupType);
            });
        } else {
          emberMochaSpecifiers.add(mappedName);
        }
      })
    // Remove all existing import specifiers
      .remove();

    emberMochaImports
      .get("specifiers")
      .replace(Array.from(emberMochaSpecifiers).map(s => j.importSpecifier(j.identifier(s))));

    // If we have an empty import, remove the import declaration
    if (emberMochaSpecifiers.size === 0) {
      emberMochaImports.remove();
    }
  }

  function processDescribeBlock() {
    let describes = root.find(j.ExpressionStatement, {
      expression: {
        callee: { name: "describe" }
      }
    });

    if (describes.length === 0) {
      return;
    }

    describes.forEach(p => {
      let mod = new ModuleInfo(p);
      if (!mod.isEmberMochaDescribe) {
        return;
      }

      mod.updateSetupInvocation();

      mod.updateTests();

      mod.updateLifecycles();
    });
  }

  const printOptions = { quote: "single", wrapColumn: 100 };

  updateToNewEmberMochaImports();
  processDescribeBlock();

  return root.toSource(printOptions);
}