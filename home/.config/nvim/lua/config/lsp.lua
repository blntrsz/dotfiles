vim.diagnostic.config({
  severity_sort = true,
  float = { border = "single", source = "if_many" },
  virtual_text = { source = "if_many" },
})

local hover_border = "rounded"

local group = vim.api.nvim_create_augroup("user-lsp-attach", { clear = true })

vim.api.nvim_create_autocmd("LspAttach", {
  group = group,
  callback = function(event)
    local map = function(mode, lhs, rhs, desc)
      vim.keymap.set(mode, lhs, rhs, {
        buffer = event.buf,
        desc = desc,
        silent = true,
      })
    end

    map("n", "gd", vim.lsp.buf.definition, "LSP definition")
    map("n", "gr", vim.lsp.buf.references, "LSP references")
    map("n", "gD", vim.lsp.buf.declaration, "LSP declaration")
    map("n", "gi", vim.lsp.buf.implementation, "LSP implementation")

    map("n", "K", function()
      vim.lsp.buf.hover({
        border = hover_border,
        title = " Hover ",
      })
    end, "LSP hover")
    map({ "n", "x" }, "<leader>ca", vim.lsp.buf.code_action, "LSP code action")
    map("n", "<leader>cr", vim.lsp.buf.rename, "LSP rename")
    map("n", "<leader>o", vim.lsp.buf.document_symbol, "LSP document symbols")
    map("n", "<leader>h", function()
      vim.diagnostic.jump({ count = -1, float = true })
    end, "Prev diagnostic")
    map("n", "<leader>l", function()
      vim.diagnostic.jump({ count = 1, float = true })
    end, "Next diagnostic")
    map("n", "<leader>q", function()
      vim.diagnostic.open_float({ scope = "cursor" })
    end, "Cursor diagnostics")
  end,
})
