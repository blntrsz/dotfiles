local parsers = { "javascript", "typescript", "tsx", "css", "html", "markdown", "markdown_inline" }
local filetypes = { "javascript", "javascriptreact", "typescript", "typescriptreact", "css", "html", "markdown" }

local function start_treesitter(buf)
  pcall(vim.treesitter.start, buf)
end

return {
  {
    "nvim-treesitter/nvim-treesitter",
    branch = "main",
    lazy = false,
    build = ":TSUpdate",
    init = function()
      vim.api.nvim_create_autocmd("FileType", {
        pattern = filetypes,
        callback = function(args)
          start_treesitter(args.buf)
        end,
      })
    end,
    config = function()
      require("nvim-treesitter").install(parsers)
    end,
  },
}
