const fs = require("fs");
const Path = require("path");
const glob = require("glob");
const xcode = require("@raydeck/xcode");
const prettier = require("prettier");
function getRootIOSPath(initialPath) {
  if (!initialPath) initialPath = process.cwd();
  else initialPath = Path.resolve(process.cwd(), initialPath);
  const globs = glob.sync(Path.join(initialPath, "**", "*xcodeproj"));
  if (!globs) return false;
  return Path.dirname(globs[0]);
}
function getBridgingModuleTextFromPath(initialPath) {
  const classInfo = getClassesFromPath(initialPath);
  return getBridgingModuleTextFromClasses(classInfo);
}
function getClassesFromPath(initialPath) {
  const newdir = getRootIOSPath(initialPath);
  const out = processDir(newdir);
  if (!out) return false;
  //Convert file output to class-based output independent of files
  var classes = {};
  Object.keys(out).forEach(path => {
    const cls = out[path];
    if (!cls) return;
    Object.keys(cls).forEach(cl => {
      const obj = cls[cl];
      classes[cl] = obj;
    });
  });
  if (!classes) return false;
  //Distill processed classes
  var processedClasses = {};
  Object.keys(classes).forEach(classname => {
    const obj = classes[classname];
    if (!obj.lines) return;
    var p = {
      name: classname,
      subclasses: obj.subclasses
    };
    if (obj.view) p.view = obj.view;
    if (
      p.subclasses.indexOf("RCTViewManager") > -1 &&
      !p.view &&
      classname.endsWith("Manager")
    ) {
      p.view = classname.substring(0, classname.length - 7);
    }
    obj.lines.forEach(line => {
      switch (line.type) {
        case "func":
          if (!p.methods) p.methods = {};
          p.methods[line.info.name] = line.info;
          break;
        case "var":
          if (!p.properties) p.properties = {};
          p.properties[line.info.name] = line.info;
          break;
        case "events":
          if (!p.events) p.events = [];
          line.info.events.map(e => {
            if (p.events.indexOf(e) == -1) p.events.push(e);
          });
          break;
        case "constants":
          if (!p.constants) p.constants = [];
          line.info.constants.map(e => {
            if (p.constants.indexOf(e) == -1) p.constants.push(e);
          });
      }
    });
    processedClasses[classname] = p;
  });
  return processedClasses;
}
function getBridgingModuleTextFromClasses(processedClasses) {
  usedEmitter = false;
  usedViewManager = false;
  outlines = ["#import <React/RCTBridgeModule.h>"];
  Object.keys(processedClasses).forEach(c => {
    //make the class header
    //Look for special classes
    var obj = processedClasses[c];
    if (!obj.methods && !obj.view) return;
    var useEmitter = false;
    var useViewManager = false;
    if (obj.subclasses) {
      if (obj.subclasses.indexOf("RCTEventEmitter") > -1) {
        useEmitter = true;
        usedEmitter = true;
      }
      if (obj.subclasses.indexOf("RCTViewManager") > -1) {
        useViewManager = true;
        usedViewManager = true;
      }
    }
    if (useEmitter) {
      outlines.push("@interface RCT_EXTERN_MODULE(" + c + ", RCTEventEmitter)");
    } else if (useViewManager) {
      outlines.push("@interface RCT_EXTERN_MODULE(" + c + ", RCTViewManager)");
    } else {
      outlines.push("@interface RCT_EXTERN_MODULE(" + c + ", NSObject)");
    }
    if (obj.methods) {
      Object.keys(obj.methods).forEach(methodName => {
        txt = "RCT_EXTERN_METHOD(" + methodName;
        const m = obj.methods[methodName];
        if (m.args) {
          m.args.forEach(arg => {
            if (!arg) return;
            var name = arg.name;
            var type = arg.type;
            var isDefault = arg.isDefault;
            if (!isDefault) {
              txt += name;
            }
            txt += ":(" + type + ")" + name + " ";
          });
        }
        txt = txt.trim() + ");";
        outlines.push(txt);
      });
    }
    if (useViewManager && obj.view) {
      const ps = getProperties(obj.view, processedClasses);
      if (ps) {
        Object.keys(ps).forEach(propertyName => {
          const p = ps[propertyName];
          const type = p.type;
          const txt =
            "RCT_EXPORT_VIEW_PROPERTY(" + propertyName + ", " + type + ");";
          outlines.push(txt);
        });
      }
    }
    outlines.push("@end");
  });

  if (usedEmitter) outlines.unshift("#import <React/RCTEventEmitter.h>");
  if (usedViewManager) outlines.unshift("#import <React/RCTViewManager.h>");
  const finalText = outlines.join("\n");
  return finalText;
}
function processDir(rootPath) {
  var out = {};
  const contents = fs.readdirSync(rootPath).filter(v => {
    if (v == "Pods") return false;
    if (v.indexOf(".") == 0) return false;
    return true;
  });
  contents.forEach(subdir => {
    const fullSubDir = Path.resolve(rootPath, subdir);
    if (fs.lstatSync(fullSubDir).isDirectory()) {
      const o = processDir(fullSubDir);
      out = { ...out, ...o };
    } else {
      const t = processFile(fullSubDir);
      if (t) out[fullSubDir] = t;
    }
  });
  return out;
}
function processFile(filePath) {
  const extension = Path.extname(filePath);
  if (extension.toLowerCase() !== ".swift") return null;
  const txt = fs.readFileSync(filePath, "utf8");
  const lines = txt.split("\n").filter(l => {
    if (l.trim().length > 0) return true;
    return false;
  });
  var foundLines = [];
  lines.filter;
  for (var x = 0; x < lines.length; x++) {
    var line = lines[x];
    if (line.match(/^\s*@objc/)) {
      var obj = { line: x, text: line };
      if (x > 0) obj.before = lines[x - 1];
      if (x < lines.length - 1) obj.after = lines[x + 1];
      var l = processLine(obj);
      if (l) foundLines.push(l);
    }
    if (line.match(/@RNS/)) {
      var obj = { line: x, text: line };
      if (x > 0) obj.before = lines[x - 1];
      if (x < lines.length - 1) obj.after = lines[x + 1];
      var l = processHint(obj);
      if (l) foundLines.push(l);
    }
  }
  //Reprocess lines into classes
  var classes = {};
  var thisClass;
  foundLines.forEach(obj => {
    console.log("This is a class and its object is ", obj);
    if (obj.type == "class") {
      var name = obj.info.name;
      if (obj.objcname) {
        name = obj.objcname;
      }
      thisClass = { name: name, subclasses: obj.info.subclasses, lines: [] };
      if (obj.view) thisClass.view = obj.view;
      classes[name] = thisClass;
    } else if (thisClass) {
      thisClass.lines.push(obj);
    } else {
      console.log("Hit error situation with line", obj, filePath);
    }
  });
  return classes;
}
function processHint(v) {
  var t = v.text.trim();
  //OK, so what does this tell us?
  if (t.indexOf("@RNSEvent") > -1) {
    //OK, so there are events on this line. let's take a look
    var words = t.split(/[^A-Za-z0-9-_]/).filter(w => {
      return (
        w.length > 0 && ["return", "RNSEvent", "RNSEvents"].indexOf(w) == -1
      );
    });
    return { type: "events", info: { events: words } };
  }
  if (t.indexOf("@RNSConstant") > -1) {
    var words = t.split(/[^A-Za-z0-9-_]/).filter(w => {
      return (
        w.length > 0 &&
        ["return", "RNSConstant", "RNSConstants"].indexOf(w) == -1
      );
    });
    return { type: "constants", info: { constants: words } };
  }
}
function processLine(v) {
  var t = v.text.trim();
  if (v.text.indexOf("@objc") > -1) {
    var t = v.text.split("@objc")[1].trim();
  }
  var firstspace = t.indexOf(" ");
  var type = t.substr(0, firstspace);
  if (["public", "private", "open"].indexOf(type) != -1) {
    const nextspace = t.indexOf(" ", firstspace + 1);
    type = t.substr(firstspace, nextspace - firstspace).trim();
    firstspace = nextspace;
  }
  if (t.indexOf("class func") > -1) {
    //Here's a tricky thing - special exception for class functions, that should never be exported
    return null;
  }
  var rest = t.substr(firstspace);
  var info;
  [v.before, v.after].forEach(line => {
    if (line && line.indexOf("@rn") > -1) {
      //after rn look for the tuples
      const after = line.substr(line.indexOf("@rn") + 3, line.length);
      const tuples = after.split(/[\s&]/);
      tuples.forEach(raw => {
        if (raw.indexOf("=" > 0)) {
          raw = raw.trim();
          const key = raw.substr(0, raw.indexOf("=")).trim();
          const val = raw.substr(raw.indexOf("=") + 1, raw.length).trim();
          if (!key.length) return;
          v[key] = val;
        } else {
          v[raw] = true;
        }
      });
    }
  });
  if (v.before && v.before.indexOf("@rn") > -1) {
  }
  switch (type) {
    case "":
      //This could be  because I have a class in the next line. Check it out?
      if (
        v.after &&
        (v.after.indexOf("class") > -1 ||
          v.after.indexOf("func") > -1 ||
          v.after.indexOf("var") > -1)
      ) {
        v.objcname = t.substr(1, t.length - 2);
        v.text = v.after;
        delete v.after;
        return processLine(v);
      }
      return null;
    case "class":
      //Get the subclasses
      //Remove curlybrace

      if (rest.indexOf("{") > -1) {
        rest = rest.substr(0, rest.indexOf("{"));
      }
      if (rest.indexOf(":") > -1) {
        var subclasses = rest
          .substr(rest.indexOf(":") + 1, rest.length)
          .split(",")
          .map(v => {
            return v.trim();
          });
        info = {
          name: rest.substr(0, rest.indexOf(":")).trim(),
          subclasses: subclasses
        };
      } else {
        info = { name: rest.trim() };
      }
      if (v.objcname) info.name = v.objcname;
      break;
    case "func":
      const name = rest.substr(0, rest.indexOf("(")).trim();
      var argstr = rest.substr(rest.indexOf("(") + 1, rest.length);
      if (argstr.indexOf("{") > -1) {
        argstr = argstr.substr(0, argstr.indexOf("{"));
      }
      if (argstr.indexOf(")") > -1) {
        argstr = argstr.substr(0, argstr.indexOf(")"));
      }
      args = argstr.split(",").map(v => {
        return v.trim();
      });
      args = args.map(arg => {
        const colonpos = arg.indexOf(":");
        const name = arg.substr(0, colonpos).trim();
        const type = arg.substr(colonpos + 1, arg.length).trim();

        if (!name) return null;
        return { name: name, type: getOCType(type) };
      });
      if (args[0] && args[0].name.indexOf("_") === 0) {
        const pieces = args[0].name.split(" ");
        args[0].name = pieces[1];
        args[0].isDefault = true;
      }
      info = { name: name, args: args };
      break;
    case "var":
      //Check for a type
      const colonPos = rest.indexOf(":");
      const eqPos = rest.indexOf(":");
      if (colonPos > -1 && (eqPos > -1 || colonPos > eqPos)) {
        const name = rest.substr(0, colonPos).trim();
        if (v.type) {
          info = { name: name, type: getOCType(v.type) };
          break;
        }
        //The word following the colon is the type
        var afterColon = rest.substr(colonPos + 1, rest.length);
        if (afterColon.indexOf("{") > -1)
          afterColon = afterColon.substr(0, afterColon.indexOf("{"));
        const eqPos2 = afterColon.indexOf("=");
        if (eqPos2 > -1) {
          const type = getOCType(afterColon.substr(0, eqPos2).trim());
          info = { name: name, type: type };
          break;
        } else {
          const type = getOCType(afterColon.trim());
          info = { name: name, type: type };
          break;
        }
      }
      console.log("I don't know what to do with ", rest);
  }
  return {
    type,
    info
  };
}
function getOCType(type) {
  type = type.trim();
  if (type.substr(-1) == "?") type = type.substr(0, type.length - 1);
  if (type.indexOf("@") === 0)
    type = type.substr(type.indexOf(" ") + 1, type.length - 1);
  switch (type) {
    case "Int":
    case "Int32":
    case "Integer":
      return "NSInteger";
    case "Float":
      return "float";
    case "Double":
      return "double";
    // return "NSNumber *";
    case "NSInteger":
      return type;
    case "String":
      return "NSString *";
    case "jsonType":
      return "NSDictionary *";
    case "Bool":
      return "BOOL";
    case "URL":
      return "NSURL *";
    case "Date":
      return "NSDate *";
    case "Any":
      return "id";
    default:
      //Try some new techniques
      if (type.indexOf("[") === 0) {
        if (type.indexOf(":") > 0) {
          return "NSDictionary *";
        } else {
          return "NSArray *";
        }
      }
      if (type.indexOf("Block") > -1) {
        return type;
      } else {
        return type + " *";
      }
  }
  return type;
}
function getProperties(className, processedClasses) {
  const obj = processedClasses[className];
  if (obj && obj.properties) {
    return obj.properties;
  }
  return null;
}
function writeIf(outfile, text) {
  if (fs.existsSync(outfile)) {
    const oldText = fs.readFileSync(outfile, "utf8");
    if (oldText == text) {
      return false;
    } else {
      fs.unlinkSync(outfile);
    }
  }
  const result = fs.writeFileSync(outfile, text);
  if (result) console.log("Could not write file", outfile);
  return true;
}
function getProjectPath(path) {
  if (!path) path = process.cwd();
  const iosPath = getRootIOSPath(path);
  const globs = glob.sync(
    Path.join(iosPath, "**", "*xcodeproj", "project.pbxproj")
  );
  if (!globs || !globs.length) return false;
  return globs[0];
}
function addModuleToPBXProj(outfile, iosPath) {
  const projpath = getProjectPath(iosPath);
  if (!projpath) return false;
  const project = xcode.project(projpath);
  project.parseSync();
  //Find my file - outfile!
  const basename = Path.basename(outfile);
  project.addSourceFileNew(basename);

  const out = project.writeSync();
  fs.writeFileSync(projpath, out);
}
function getJSFromPath(thisPath) {
  const classes = getClassesFromPath(thisPath);
  var methods = 0;
  var components = 0;
  var exportables = [];
  var outlines = [];
  var events = [];
  var constants = [];
  Object.keys(classes).forEach(k => {
    const obj = classes[k];
    const NativeObj = "Native" + k;
    if (obj.methods) {
      outlines.push("//#region Code for object " + k);
      outlines.push("const " + NativeObj + " = NativeModules." + k);
      Object.keys(obj.methods).forEach(m => {
        methods++;
        const mobj = obj.methods[m];
        const JSm = exportables.indexOf(m) > -1 ? k + m : m;
        const async =
          mobj.args.filter(arg => {
            return arg && arg.type == "RCTPromiseResolveBlock";
          }).length > 0
            ? "async "
            : "";
        const isAwait = async ? "await " : "";
        const filteredKeys = mobj.args
          .filter(arg => {
            return (
              !arg ||
              ["RCTPromiseRejectBlock", "RCTPromiseResolveBlock"].indexOf(
                arg.type
              ) == -1
            );
          })
          .map(arg => {
            return arg ? arg.name : null;
          });
        var line =
          "const " +
          JSm +
          " = " +
          async +
          "(" +
          filteredKeys.join(", ") +
          ") => {\n  return " +
          isAwait +
          NativeObj +
          "." +
          m +
          "(" +
          filteredKeys.join(", ") +
          ");\n}";
        outlines.push(line);
        exportables.push(JSm);
      });
      outlines.push("//#endregion");
    }
    if (obj.events) {
      outlines.push("//#region events for object " + k);
      const nativeEventEmitterFunction = "get" + NativeObj + "EventEmitter";
      outlines.push("var _" + nativeEventEmitterFunction + " = null");
      outlines.push(
        "const " +
          nativeEventEmitterFunction +
          " = () => { if(!_" +
          nativeEventEmitterFunction +
          ") _" +
          nativeEventEmitterFunction +
          "= new NativeEventEmitter(" +
          NativeObj +
          "); return _" +
          nativeEventEmitterFunction +
          "}"
      );
      obj.events.forEach(event => {
        const methodName = "subscribeTo" + event;
        outlines.push(
          "const " +
            methodName +
            " = cb=>{ return " +
            nativeEventEmitterFunction +
            '().addListener("' +
            event +
            '", cb)}'
        );
        exportables.push(methodName);
        events.push({ event, methodName });
      });
      outlines.push("//#endregion");
    }
    if (obj.constants) {
      outlines.push("//#region constants for object " + k);
      obj.constants.forEach(constant => {
        const constantName = constant;
        outlines.push(
          "const " + constantName + " = " + NativeObj + "." + constant
        );
        constants.push({ constant, NativeObj });
        exportables.push(constant);
      });
      outlines.push("//#endregion");
    }
    if (obj.view) {
      components++;
      const componentName = obj.view;
      const nativeName = "Native" + obj.view;
      const requireLine =
        "const " +
        nativeName +
        " = requireNativeComponent('" +
        obj.view +
        "'," +
        componentName +
        ")";
      outlines.push(requireLine);
      outlines.push("class " + componentName + " extends Component {");
      outlines.push("render() {");
      outlines.push("return <" + nativeName + " {...this.props} />");
      outlines.push("}");
      outlines.push("}");
      outlines.push(componentName + ".propTypes = {");
      if (classes[obj.view] && classes[obj.view].properties) {
        Object.keys(classes[obj.view].properties).forEach(propName => {
          const pobj = classes[obj.view].properties[propName];

          outlines.push(
            propName + ": " + "PropTypes." + getPropTypeFromObject(pobj) + ","
          );
        });
      }

      outlines.push("...ViewPropTypes");
      outlines.push("}");
      exportables.push(componentName);
    }
  });
  if (events.length > 0) {
    outlines.push("//#region Event marshalling object");
    outlines.push("const RNSEvents = {");
    events.forEach(({ event, methodName }) => {
      outlines.push(event + ": " + methodName);
      outlines.push(",");
    });
    outlines.pop();
    outlines.push("}");
    outlines.push("//#endregion");
    exportables.push("RNSEvents");
  }
  if (methods > 0) {
    outlines.unshift(
      'import { NativeModules, NativeEventEmitter, requireNativeComponent, ViewPropTypes } from "react-native"'
    );
    outlines.unshift('import React, { Component } from "react"');
    outlines.unshift('import { PropTypes } from "prop-types"');
  } else if (components > 0) {
    outlines.unshift(
      'import { requireNativeComponent,  ViewPropTypes } from "react-native"'
    );
    outlines.unshift('import React, { Component } from "react"');
    outlines.unshift('import { PropTypes } from "prop-types"');
  } else if (methods > 0) {
    outlines.unshift(
      'import { NativeModules, NativeEventEmitter } from "react-native"'
    );
  }
  outlines.push("//#region Exports");
  outlines.push("export {\n  " + exportables.join(",\n  ") + "\n}");
  outlines.push("//#endregion");
  // const out = outlines.join("\n");
  const out = prettier.format(outlines.join("\n"));

  return out;
}
function getPropTypeFromObject(pobj) {
  switch (pobj.type) {
    case "NSString *":
      return "string";
    case "BOOL":
      return "bool";
    case "NSInteger":
    case "float":
    case "double":
      return "number";
    case "NSArray *":
      return "array";
    default:
      return "object";
  }
}
module.exports = {
  getBridgingModuleTextFromPath,
  getBridgingModuleTextFromClasses,
  getClassesFromPath,
  getRootIOSPath,
  writeIf,
  addModuleToPBXProj,
  getJSFromPath
};
