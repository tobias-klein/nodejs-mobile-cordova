var path = require("path");
var fs = require("fs");

module.exports = function (context) {
  var xcode = require("xcode");

  // Require the iOS platform Api to get the Xcode .pbxproj path.
  var iosPlatformPath = path.join(context.opts.projectRoot, "platforms", "ios");
  var iosAPI = require(path.join(iosPlatformPath, "cordova", "Api"));
  var iosAPIInstance = new iosAPI("ios", iosPlatformPath);
  var pbxprojPath = iosAPIInstance.locations.pbxproj;

  // Read the Xcode project and get the target.
  var xcodeProject = xcode.project(pbxprojPath);
  xcodeProject.parseSync();
  
  // Find the proper target (Application), as getFirstTarget() might return a test target in newer Xcode versions.
  var firstTargetUUID;
  var targets = xcodeProject.pbxNativeTargetSection();
  for (var key in targets) {
    if (key.indexOf("_comment") < 0) {
      var target = targets[key];
      if (target.productType === '"com.apple.product-type.application"') {
        firstTargetUUID = key;
        break;
      }
    }
  }
  if (!firstTargetUUID) {
    firstTargetUUID = xcodeProject.getFirstTarget().uuid;
  }

  // Adds a build phase to rebuild native modules.
  var rebuildNativeModulesBuildPhaseName =
    "Build Node.js Mobile Native Modules";
  var rebuildNativeModulesBuildPhaseScript = `
set -e

echo "===== DEBUG: Script started ====="
echo "DEBUG: CODESIGNING_FOLDER_PATH=$CODESIGNING_FOLDER_PATH"
echo "DEBUG: PROJECT_DIR=$PROJECT_DIR"
echo "DEBUG: PRODUCT_SETTINGS_PATH=$PRODUCT_SETTINGS_PATH"
echo "DEBUG: PLATFORM_NAME=$PLATFORM_NAME"
echo "DEBUG: HOST_ARCH=$HOST_ARCH"

alias python=python3

# On M1 macs homebrew is located outside /usr/local/bin
if [[ ! $PATH =~ /opt/homebrew/bin: ]]; then
  PATH="/opt/homebrew/bin/:/opt/homebrew/sbin:$PATH"
fi
echo "DEBUG: PATH updated for homebrew"

# Xcode executes script build phases in independant shell environment.
# Force load users configuration file
echo "DEBUG: ZDOTDIR=$ZDOTDIR"
if [ -f "$ZDOTDIR"/.zshrc ]; then
  echo "DEBUG: Sourcing .zshrc..."
  set +e
  source "$ZDOTDIR"/.zshrc
  ZSHRC_EXIT=$?
  set -e
  echo "DEBUG: .zshrc exit code: $ZSHRC_EXIT"
else
  echo "DEBUG: No .zshrc found"
fi

echo "DEBUG: node version: $(node --version 2>&1 || echo 'not found')"
echo "DEBUG: npm version: $(npm --version 2>&1 || echo 'not found')"

if [ -z "$NODEJS_MOBILE_BUILD_NATIVE_MODULES" ]; then
# If build native modules preference is not set, look for it in the project's
# www/NODEJS_MOBILE_BUILD_NATIVE_MODULES_VALUE.txt
  PREFERENCE_FILE_PATH="$CODESIGNING_FOLDER_PATH/www/NODEJS_MOBILE_BUILD_NATIVE_MODULES_VALUE.txt"
  echo "DEBUG: Checking preference file: $PREFERENCE_FILE_PATH"
  if [ -f "$PREFERENCE_FILE_PATH" ]; then
    NODEJS_MOBILE_BUILD_NATIVE_MODULES="$(cat $PREFERENCE_FILE_PATH | xargs)"
    echo "DEBUG: Preference file value: $NODEJS_MOBILE_BUILD_NATIVE_MODULES"
  fi
fi
if [ -z "$NODEJS_MOBILE_BUILD_NATIVE_MODULES" ]; then
# If build native modules preference is not set, try to find .gyp files
#to turn it on.
  echo "DEBUG: Searching for .gyp files..."
  gypfiles=($(find "$CODESIGNING_FOLDER_PATH/www/nodejs-project/" -type f -name "*.gyp"))
  echo "DEBUG: Found \${#gypfiles[@]} .gyp files"
  if [ \${#gypfiles[@]} -gt 0 ]; then
    NODEJS_MOBILE_BUILD_NATIVE_MODULES=1
  else
    NODEJS_MOBILE_BUILD_NATIVE_MODULES=0
  fi
fi
echo "DEBUG: NODEJS_MOBILE_BUILD_NATIVE_MODULES=$NODEJS_MOBILE_BUILD_NATIVE_MODULES"
if [ "1" != "$NODEJS_MOBILE_BUILD_NATIVE_MODULES" ]; then 
  echo "DEBUG: Skipping native modules build"
  exit 0
fi

echo "DEBUG: Cleaning old build artifacts..."
# Delete object files that may already come from within the npm package.
find "$CODESIGNING_FOLDER_PATH/www/nodejs-project/" -name "*.o" -type f -delete
find "$CODESIGNING_FOLDER_PATH/www/nodejs-project/" -name "*.a" -type f -delete
find "$CODESIGNING_FOLDER_PATH/www/nodejs-project/" -name "*.node" -type f -delete
# Delete bundle contents that may be there from previous builds.
find "$CODESIGNING_FOLDER_PATH/www/nodejs-project/" -path "*/*.node/*" -delete
find "$CODESIGNING_FOLDER_PATH/www/nodejs-project/" -name "*.node" -type d -delete
find "$CODESIGNING_FOLDER_PATH/www/nodejs-project/" -path "*/*.framework/*" -delete
find "$CODESIGNING_FOLDER_PATH/www/nodejs-project/" -name "*.framework" -type d -delete
# Symlinks to binaries are resolved by cordova prepare during the copy, causing build time errors.
# The original project's .bin folder will be added to the path before building the native modules.
find "$CODESIGNING_FOLDER_PATH/www/nodejs-project/" -path "*/.bin/*" -delete
find "$CODESIGNING_FOLDER_PATH/www/nodejs-project/" -name ".bin" -type d -delete
echo "DEBUG: Cleanup complete"

# ===== macOS 26 / Xcode 26 WORKAROUND =====
# Build native modules in a temp directory to avoid EPERM errors
# when node-gyp tries to mkdir inside the .app bundle.
TEMP_BUILD_DIR=$(mktemp -d)
echo "DEBUG: Created temp build directory: $TEMP_BUILD_DIR"

# Copy nodejs-project to temp directory
echo "DEBUG: Copying nodejs-project to temp directory..."
cp -R "$CODESIGNING_FOLDER_PATH/www/nodejs-project" "$TEMP_BUILD_DIR/"
TEMP_NODEJS_PROJECT="$TEMP_BUILD_DIR/nodejs-project"
echo "DEBUG: TEMP_NODEJS_PROJECT=$TEMP_NODEJS_PROJECT"

# Get the nodejs-mobile-gyp location
echo "DEBUG: Looking for nodejs-mobile-gyp..."
if [ -d "$PROJECT_DIR/../../plugins/@red-mobile/nodejs-mobile-cordova/node_modules/nodejs-mobile-gyp/" ]; then
echo "DEBUG: Found in plugins dir"
NODEJS_MOBILE_GYP_DIR="$( cd "$PROJECT_DIR" && cd ../../plugins/@red-mobile/nodejs-mobile-cordova/node_modules/nodejs-mobile-gyp/ && pwd )"
else
echo "DEBUG: Checking node_modules dir"
NODEJS_MOBILE_GYP_DIR="$( cd "$PROJECT_DIR" && cd ../../node_modules/nodejs-mobile-gyp/ && pwd )"
fi
NODEJS_MOBILE_GYP_BIN_FILE="$NODEJS_MOBILE_GYP_DIR"/bin/node-gyp.js
echo "DEBUG: NODEJS_MOBILE_GYP_DIR=$NODEJS_MOBILE_GYP_DIR"
echo "DEBUG: NODEJS_MOBILE_GYP_BIN_FILE=$NODEJS_MOBILE_GYP_BIN_FILE"

# Rebuild modules with right environment
echo "DEBUG: Setting NODEJS_HEADERS_DIR from PRODUCT_SETTINGS_PATH=$PRODUCT_SETTINGS_PATH"
NODEJS_HEADERS_DIR="$( cd "$( dirname "$PRODUCT_SETTINGS_PATH" )" && cd Plugins/@red-mobile/nodejs-mobile-cordova/ && pwd )"
echo "DEBUG: NODEJS_HEADERS_DIR=$NODEJS_HEADERS_DIR"

# Adds the original project .bin to the path. It's a workaround
# to correctly build some modules that depend on symlinked modules,
# like node-pre-gyp.
if [ -d "$PROJECT_DIR/../../www/nodejs-project/node_modules/.bin/" ]; then
  PATH="$PROJECT_DIR/../../www/nodejs-project/node_modules/.bin/:$PATH"
fi

# Build in temp directory instead of .app bundle
echo "DEBUG: Changing to $TEMP_NODEJS_PROJECT"
pushd "$TEMP_NODEJS_PROJECT"
export GYP_DEFINES="OS=ios"
export npm_config_nodedir="$NODEJS_HEADERS_DIR"
export npm_config_node_gyp="$NODEJS_MOBILE_GYP_BIN_FILE"
export npm_config_format="make-ios"
export npm_config_node_engine="chakracore"
export NODEJS_MOBILE_GYP="$NODEJS_MOBILE_GYP_BIN_FILE"
export npm_config_platform="ios"

if [[ "$PLATFORM_NAME" == "iphoneos" ]]; then
  export npm_config_arch="arm64"
  echo "DEBUG: Target arch: arm64 (iphoneos)"
else
  if [[ "$HOST_ARCH" == "arm64" ]] ; then # M1 mac
    export GYP_DEFINES="OS=ios iossim=true"
    export npm_config_arch="arm64"
    echo "DEBUG: Target arch: arm64 (simulator on M1)"
  else
    export npm_config_arch="x64"
    echo "DEBUG: Target arch: x64 (simulator on Intel)"
  fi
fi
echo "DEBUG: Running npm rebuild in temp directory..."
npm --verbose rebuild --build-from-source
echo "DEBUG: npm rebuild completed"
popd

# Copy compiled .framework directories back to the .app bundle
echo "DEBUG: Copying compiled frameworks back to .app bundle..."
find "$TEMP_NODEJS_PROJECT" -name "*.framework" -type d | while read framework_path; do
  rel_path="\${framework_path#$TEMP_NODEJS_PROJECT/}"
  target_dir="$CODESIGNING_FOLDER_PATH/www/nodejs-project/\$(dirname "\$rel_path")"
  echo "DEBUG: Copying framework: \$rel_path"
  mkdir -p "\$target_dir"
  cp -R "\$framework_path" "\$target_dir/"
done

# Copy any .node files/directories back as well
find "$TEMP_NODEJS_PROJECT" -name "*.node" | while read node_path; do
  rel_path="\${node_path#$TEMP_NODEJS_PROJECT/}"
  target_dir="$CODESIGNING_FOLDER_PATH/www/nodejs-project/\$(dirname "\$rel_path")"
  echo "DEBUG: Copying .node: \$rel_path"
  mkdir -p "\$target_dir"
  cp -R "\$node_path" "\$target_dir/"
done

# Copy build directories (contains Makefiles and intermediate files needed for signing)
find "$TEMP_NODEJS_PROJECT" -type d -name "build" -path "*/node_modules/*/build" | while read build_path; do
  rel_path="\${build_path#$TEMP_NODEJS_PROJECT/}"
  target_dir="$CODESIGNING_FOLDER_PATH/www/nodejs-project/\$(dirname "\$rel_path")"
  echo "DEBUG: Copying build dir: \$rel_path"
  mkdir -p "\$target_dir"
  cp -R "\$build_path" "\$target_dir/"
done

# Cleanup temp directory
echo "DEBUG: Cleaning up temp directory..."
rm -rf "$TEMP_BUILD_DIR"

echo "===== DEBUG: Script finished successfully ====="
`;
  var rebuildNativeModulesBuildPhase = xcodeProject.buildPhaseObject(
    "PBXShellScriptBuildPhase",
    rebuildNativeModulesBuildPhaseName,
    firstTargetUUID,
  );
  if (!rebuildNativeModulesBuildPhase) {
    xcodeProject.addBuildPhase(
      [],
      "PBXShellScriptBuildPhase",
      rebuildNativeModulesBuildPhaseName,
      firstTargetUUID,
      {
        shellPath: "/bin/zsh",
        shellScript: rebuildNativeModulesBuildPhaseScript,
      },
    );
  }

  // Adds a build phase to sign native modules.
  var signNativeModulesBuildPhaseName = "Sign Node.js Mobile Native Modules";
  var signNativeModulesBuildPhaseScript = `
set -e

echo "===== DEBUG: Sign script started ====="
echo "DEBUG: CODESIGNING_FOLDER_PATH=$CODESIGNING_FOLDER_PATH"
echo "DEBUG: PROJECT_DIR=$PROJECT_DIR"
echo "DEBUG: TARGET_BUILD_DIR=$TARGET_BUILD_DIR"
echo "DEBUG: FRAMEWORKS_FOLDER_PATH=$FRAMEWORKS_FOLDER_PATH"
echo "DEBUG: EXPANDED_CODE_SIGN_IDENTITY=$EXPANDED_CODE_SIGN_IDENTITY"

# On M1 macs homebrew is located outside /usr/local/bin
if [[ ! $PATH =~ /opt/homebrew/bin: ]]; then
  PATH="/opt/homebrew/bin/:/opt/homebrew/sbin:$PATH"
fi
# Xcode executes script build phases in independant shell environment.
# Force load users configuration file
if [ -f "$ZDOTDIR"/.zshrc ]; then
  set +e
  source "$ZDOTDIR"/.zshrc
  set -e
fi

if [ -z "$NODEJS_MOBILE_BUILD_NATIVE_MODULES" ]; then
# If build native modules preference is not set, look for it in the project's
# www/NODEJS_MOBILE_BUILD_NATIVE_MODULES_VALUE.txt
  PREFERENCE_FILE_PATH="$CODESIGNING_FOLDER_PATH/www/NODEJS_MOBILE_BUILD_NATIVE_MODULES_VALUE.txt"
  if [ -f "$PREFERENCE_FILE_PATH" ]; then
    NODEJS_MOBILE_BUILD_NATIVE_MODULES="$(cat $PREFERENCE_FILE_PATH | xargs)"
    # Remove the preference file so it doesn't get in the application package.
    rm "$PREFERENCE_FILE_PATH"
  fi
fi
if [ -z "$NODEJS_MOBILE_BUILD_NATIVE_MODULES" ]; then
# If build native modules preference is not set, try to find .gyp files
#to turn it on.
  gypfiles=($(find "$CODESIGNING_FOLDER_PATH/www/nodejs-project/" -type f -name "*.gyp"))
  if [ \${#gypfiles[@]} -gt 0 ]; then
    NODEJS_MOBILE_BUILD_NATIVE_MODULES=1
  else
    NODEJS_MOBILE_BUILD_NATIVE_MODULES=0
  fi
fi
echo "DEBUG: NODEJS_MOBILE_BUILD_NATIVE_MODULES=$NODEJS_MOBILE_BUILD_NATIVE_MODULES"
if [ "1" != "$NODEJS_MOBILE_BUILD_NATIVE_MODULES" ]; then 
  echo "DEBUG: Skipping sign phase"
  exit 0
fi

# Delete object files
echo "DEBUG: Deleting object files..."
find "$CODESIGNING_FOLDER_PATH/www/nodejs-project/" -name "*.o" -type f -delete
find "$CODESIGNING_FOLDER_PATH/www/nodejs-project/" -name "*.a" -type f -delete

# Create Info.plist for each framework built and loader override.
echo "DEBUG: Looking for patch script dir..."
PATCH_SCRIPT_DIR="$( cd "$PROJECT_DIR" && cd ../../Plugins/@red-mobile/nodejs-mobile-cordova/install/helper-scripts/ && pwd )"
echo "DEBUG: PATCH_SCRIPT_DIR=$PATCH_SCRIPT_DIR"
NODEJS_PROJECT_DIR="$( cd "$CODESIGNING_FOLDER_PATH" && cd www/nodejs-project/ && pwd )"
echo "DEBUG: NODEJS_PROJECT_DIR=$NODEJS_PROJECT_DIR"

echo "DEBUG: Listing .node directories:"
find "$NODEJS_PROJECT_DIR" -name "*.node" -type d 2>/dev/null || echo "DEBUG: No .node directories found"
echo "DEBUG: Listing .framework directories:"
find "$NODEJS_PROJECT_DIR" -name "*.framework" -type d 2>/dev/null || echo "DEBUG: No .framework directories found"

echo "DEBUG: Running ios-create-plists-and-dlopen-override.js..."
node "$PATCH_SCRIPT_DIR"/ios-create-plists-and-dlopen-override.js $NODEJS_PROJECT_DIR
echo "DEBUG: Patch script completed"

# Embed every resulting .framework in the application and delete them afterwards.
embed_framework()
{
    FRAMEWORK_NAME="\$(basename "\$1")"
    echo "DEBUG: Embedding framework: \$FRAMEWORK_NAME"
    mkdir -p "$TARGET_BUILD_DIR/$FRAMEWORKS_FOLDER_PATH/"
    cp -r "\$1" "$TARGET_BUILD_DIR/$FRAMEWORKS_FOLDER_PATH/"
    if [ -n "$EXPANDED_CODE_SIGN_IDENTITY" ]; then
      echo "DEBUG: Signing framework with identity: $EXPANDED_CODE_SIGN_IDENTITY"
      /usr/bin/codesign --force --sign $EXPANDED_CODE_SIGN_IDENTITY --preserve-metadata=identifier,entitlements,flags --timestamp=none "$TARGET_BUILD_DIR/$FRAMEWORKS_FOLDER_PATH/\$FRAMEWORK_NAME"
    else
      echo "DEBUG: No code sign identity, skipping signing"
    fi
}
echo "DEBUG: Finding frameworks to embed..."
find "$CODESIGNING_FOLDER_PATH/www/nodejs-project/" -name "*.framework" -type d | while read frmwrk_path; do 
  echo "DEBUG: Found framework: \$frmwrk_path"
  embed_framework "\$frmwrk_path"
done

#Delete gyp temporary .deps dependency folders from the project structure.
echo "DEBUG: Cleaning up .deps folders..."
find "$CODESIGNING_FOLDER_PATH/www/nodejs-project/" -path "*/.deps/*" -delete
find "$CODESIGNING_FOLDER_PATH/www/nodejs-project/" -name ".deps" -type d -delete

#Delete frameworks from their build paths
echo "DEBUG: Cleaning up frameworks from build paths..."
find "$CODESIGNING_FOLDER_PATH/www/nodejs-project/" -path "*/*.framework/*" -delete
find "$CODESIGNING_FOLDER_PATH/www/nodejs-project/" -name "*.framework" -type d -delete

echo "===== DEBUG: Sign script finished successfully ====="
`;
  var signNativeModulesBuildPhase = xcodeProject.buildPhaseObject(
    "PBXShellScriptBuildPhase",
    signNativeModulesBuildPhaseName,
    firstTargetUUID,
  );
  if (!signNativeModulesBuildPhase) {
    xcodeProject.addBuildPhase(
      [],
      "PBXShellScriptBuildPhase",
      signNativeModulesBuildPhaseName,
      firstTargetUUID,
      { shellPath: "/bin/zsh", shellScript: signNativeModulesBuildPhaseScript },
    );
  }

  // Write the changes into the Xcode project.
  fs.writeFileSync(pbxprojPath, xcodeProject.writeSync());
};
