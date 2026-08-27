return {
  "Shatur/neovim-ayu",
  lazy = false,
  priority = 1000,
  opts = {},
  config = function()
    -- load the colorscheme here
    vim.cmd([[colorscheme ayu]])
  end,
}
