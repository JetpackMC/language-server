<div align="center">

<img src="./assets/jetpack.png" alt="Jetpack" width="480"><br>

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

Install **Jetpack Language Support** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jetpack-community.jetpack-language-support), or search for it in the Extensions view.

You can also install it from the command line:

```sh
code --install-extension jetpack-community.jetpack-language-support
```

Alternatively, download the latest `.vsix` file from [GitHub Releases](https://github.com/JetpackMC/language-server/releases) and install it through the Extensions view with `...` > `Install from VSIX...`.

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

## Contributing

Thank you for contributing to the Jetpack project.
If you would like to contribute, please read [CONTRIBUTING.md](CONTRIBUTING.md).

![Contributors](https://contrib.rocks/image?repo=JetpackMC/language-server)

## License

The Jetpack project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
