vim.defer_fn(function()
  pcall(require, "impatient")
end, 0)

-- options should be first
require "options"

-- plugins second
require "plugins"

-- then everything else
require "mappings"
require "lsp"
