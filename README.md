<div align="center">

<img src="./assets/jetpack.png" alt="Jetpack"><br>

# Jetpack Language Support

Jetpack Language Support is a VS Code extension for Jetpack `.jet` scripts.  
Write Minecraft Paper server scripts with syntax highlighting, diagnostics, navigation, and completion.

</div>

## Features

- syntax highlighting for `.jet` files
- static diagnostics for syntax, names, imports, and types
- completion for keywords, events, symbols, modules, and members
- hover, definition, references, rename, semantic tokens, and document symbols

## Installation

Download the latest `.vsix` file from [GitHub Releases](https://github.com/JetpackMC/language-server/releases), then install it in VS Code:

```sh
code --install-extension jetpack-language-support-<version>.vsix
```

You can also install it through VS Code:

1. Open the Extensions view.
2. Select `...` > `Install from VSIX...`.
3. Choose the downloaded `.vsix` file.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `jetpack.diagnostics.enable` | `true` | Enables static diagnostics. |
| `jetpack.scriptsRoot` | `""` | Scripts root for resolving `using` paths. |
| `jetpack.trace.server` | `"off"` | Traces communication between VS Code and the language server. |

## Development

Install dependencies and compile:

```sh
npm ci
npm run compile
```

Package a local `.vsix`:

```sh
npm run package:vsix -- --out jetpack-language-support.vsix
```

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
