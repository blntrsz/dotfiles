return {
  "nvim-telescope/telescope.nvim",
  dependencies = { "nvim-lua/plenary.nvim" },
  opts = {
    pickers = {
      find_files = {
        hidden = true,
      },
      git_files = {
        hidden = true,
      },
    },
    defaults = {
      file_ignore_patterns = {
        "node_modules/*",
        ".git/*",
      },
    },
  },
  keys = {
    { "<leader><leader>", "<cmd>Telescope find_files theme=ivy<cr>" },
    { "<leader>gs",       "<cmd>Telescope git_status theme=ivy<cr>" },
  },
}
