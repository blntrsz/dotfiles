return {
  {
    "nvim-neo-tree/neo-tree.nvim",
    branch = "v3.x",
    dependencies = {
      "nvim-lua/plenary.nvim",
      "nvim-tree/nvim-web-devicons",
      "MunifTanjim/nui.nvim",
    },
    keys = {
      { "<leader>e", "<cmd>Neotree toggle<cr>", desc = "NvimTree" },
    },
    config = function()
      require("neo-tree").setup({
        window = {
          mappings = {
            ["l"] = "open",
            ["h"] = "close_node",
          },
        },
        filesystem = {
          filtered_items = {
            hide_dotfiles = false,
            hide_hidden = false,
            hide_gitignored = false,
          },
          follow_current_file = {
            enabled = true,
            leave_dirs_open = true,
          },
        },
      })
    end,
  },
}
