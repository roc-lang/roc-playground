// Examples with embedded .roc file content
// This file contains the actual Roc code inline to ensure proper bundling

export interface Example {
  name: string;
  code: string;
  /** The actual filename sent to the Roc compiler */
  rocFilename: string;
}

export const examples: Example[] = [
  {
    name: "Hello World",
    rocFilename: "main.roc",
    code: `app [main!] { pf: platform "https://github.com/lukewilliamboswell/roc-platform-template-zig/releases/download/0.6/2BfGn4M9uWJNhDVeMghGeXNVDFijMfPsmmVeo6M4QjKX.tar.zst" }

import pf.Stdout

main! = |_args| {
    Stdout.line!("Hello, World!")
    Ok({})
}`,
  },
  {
    name: "Basic Types",
    rocFilename: "Person.roc",
    code: `Person := [].{
    name : Str
    name = "Alice"

    age : I32
    age = 25

    height : Dec
    height = 5.8

    is_active : Bool
    is_active = True

    colors : List(Str)
    colors = ["red", "green", "blue"]

    numbers : List(I32)
    numbers = [1, 2, 3, 4, 5]
}`,
  },
  {
    name: "Functions",
    rocFilename: "Color.roc",
    code: `Color := [Red, Green, Blue].{
    color_to_hex : Color -> Str
    color_to_hex = |color|
        match color {
            Red => "#FF0000"
            Green => "#00FF00"
            Blue => "#0000FF"
        }
}

add : I32, I32 -> I32
add = |a, b| a + b

multiply : I32, I32 -> I32
multiply = |x, y| x * y

greet : Str -> Str
greet = |name| "Hello, \${name}!"

is_even : I32 -> Bool
is_even = |n| n % 2 == 0

apply_twice : (I32 -> I32), I32 -> I32
apply_twice = |func, x| func(func(x))

factorial : I32 -> I32
factorial = |n| {
    if n <= 1
        1
    else
        n * factorial(n - 1)
}`,
  },
  {
    name: "Pattern Matching",
    rocFilename: "Shape.roc",
    code: `Shape := [Circle(Dec), Rectangle(Dec, Dec), Triangle(Dec, Dec)].{
    calculate_area : Shape -> Dec
    calculate_area = |shape| {
        match shape {
            Circle(radius) => 3.14159 * radius * radius
            Rectangle(width, height) => width * height
            Triangle(base, height) => 0.5 * base * height
        }
    }
}


process_try : Try(Str, Str) -> Str
process_try = |try|
    match try {
        Ok(value) => "Success: \${value}"
        Err(error) => "Error: \${error}"
    }

analyze_list : List(I32) -> Str
analyze_list = |list|
    match list {
        [] => "Empty list"
        [single] => "Single element: \${I32.to_str(single)}"
        [first, second] => "Two elements: \${I32.to_str(first)} and \${I32.to_str(second)}"
        [first, .. as rest] => "First: \${I32.to_str(first)}, rest has \${U64.to_str(rest.len())} elements"
    }`,
  },
  {
    name: "Records",
    rocFilename: "Records.roc",
    code: `Records := [].{}
    
Employee : {
    personal : Person,
    address : Address,
    salary : Dec,
    department : Str
}

Person : { name : Str, age : I32, email : Str }
Address : { street : Str, city : Str, zip_code : Str }

create_person : Str, I32, Str -> Person
create_person = |name, age, email| { name, age, email }

get_full_name : Person -> Str
get_full_name = |person| "\${person.name} <\${person.email}>"

update_age : Person, I32 -> Person
update_age = |person, new_age| { ..person, age: new_age }

move_to_new_address : Employee, Address -> Employee
move_to_new_address = |employee, new_address|
    { ..employee, address: new_address }

process_employee : Employee -> Str
process_employee = |{ personal: { name, age }, department, salary }|
    "\${name} (\${I32.to_str(age)}) works in \${department} earning \${Dec.to_str(salary)}"

Stats : { wins : I32, losses : I32, draws : I32 }

update_stats : Stats, [Win, Loss, Draw] -> Stats
update_stats = |stats, result|
    match result {
        Win => { ..stats, wins: stats.wins + 1 }
        Loss => { ..stats, losses: stats.losses + 1 }
        Draw => { ..stats, draws: stats.draws + 1 }
    }

player_summary : Stats -> { total : I32, win_rate : Dec }
player_summary = |{wins, losses, draws}| {
    total = wins + losses + draws
    win_rate = if total > 0 (I32.to_dec(wins) / I32.to_dec(total)) else 0.0

    { total, win_rate }
}

example_person : Person
example_person = create_person("Alice Johnson", 28, "alice@example.com")

example_address : Address
example_address = { street: "123 Main St", city: "Springfield", zip_code: "12345" }

example_employee : Employee
example_employee = {
    personal: example_person,
    address: example_address,
    salary: 75000.0,
    department: "Engineering",
}`,
  },
];

// Helper function to get a specific example by name
export function getExampleByName(name: string): Example | undefined {
  return examples.find((example) => example.name === name);
}

// Helper function to get example names for UI
export function getExampleNames(): string[] {
  return examples.map((example) => example.name);
}

// Export count for debugging
export const exampleCount = examples.length;
